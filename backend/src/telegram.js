import * as db from './db.js';
import { callLLM, callLLMWithUsage, extractAndStoreMemories } from './llm.js';
import { retrieveRelevantMemories } from './memoryService.js';
import { searchWeb } from './search.js';
import { executeRemoteCommand } from './sshExecutor.js';

let isRunning = false;
let abortController = null;

// Map to hold resolver functions for pending SSH command approvals
const pendingApprovals = new Map();

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getActiveSettings() {
  const currentSettings = await db.getSettings();
  return {
    apiBaseUrl: currentSettings.apiBaseUrl || 'http://localhost:11434/v1',
    apiKey: currentSettings.apiKey || '',
    model: currentSettings.model || 'llama3',
    systemPrompt: currentSettings.systemPrompt || 'You are a helpful personal assistant with an excellent long-term memory. Be helpful, concise, and friendly.',
    temperature: currentSettings.temperature !== undefined ? parseFloat(currentSettings.temperature) : 0.7,
    memorySimilarity: currentSettings.memorySimilarity !== undefined ? parseFloat(currentSettings.memorySimilarity) : 0.4,
    telegramBotToken: currentSettings.telegramBotToken || '',
    sshHost: currentSettings.sshHost || '',
    sshUser: currentSettings.sshUser || '',
    sshPort: currentSettings.sshPort || '22',
    sshPassword: currentSettings.sshPassword || '',
    sshPrivateKey: currentSettings.sshPrivateKey || ''
  };
}

/**
 * Initializes/Restarts the Telegram Bot listener using long-polling.
 */
export async function initTelegramBot() {
  if (isRunning) {
    console.log('Restarting Telegram bot listener...');
    isRunning = false;
    if (abortController) {
      abortController.abort();
    }
    await sleep(1000); // Give the loop a moment to exit
  }

  const settings = await getActiveSettings();
  if (!settings.telegramBotToken) {
    console.log('Telegram Bot Token not configured. Telegram bot integration is offline.');
    return;
  }

  console.log('Telegram Bot Token found. Starting polling loop...');
  isRunning = true;
  abortController = new AbortController();

  // Run loop in background
  runPollingLoop(settings.telegramBotToken, abortController.signal).catch(err => {
    console.error('Fatal Telegram polling error:', err);
  });
}

async function runPollingLoop(token, signal) {
  let offset = 0;
  console.log('Telegram bot listener polling has been activated.');

  while (isRunning && !signal.aborted) {
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=10`;
      const response = await fetch(url, { signal });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.description || 'Unknown error');
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        if (update.message && update.message.text) {
          const chatId = update.message.chat.id.toString();
          const userText = update.message.text;

          // Do not await to allow concurrent handling of messages
          handleTelegramMessage(token, chatId, userText);
        } else if (update.callback_query) {
          // Handle button clicks for SSH execution approvals
          handleTelegramCallback(token, update.callback_query);
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('Telegram polling loop aborted.');
        break;
      }
      console.error('Telegram polling loop error:', error.message);
      await sleep(10000); // Back off to avoid spamming
    }
    await sleep(200);
  }
}

async function handleTelegramCallback(token, callbackQuery) {
  const queryId = callbackQuery.id;
  const chatId = callbackQuery.message.chat.id.toString();
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data; // Expected format "approve:pendingId" or "reject:pendingId"

  const [action, pendingId] = data.split(':');
  const pending = pendingApprovals.get(pendingId);

  if (!pending) {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: queryId,
        text: 'Sesi persetujuan telah kedaluwarsa atau sudah diproses.',
        show_alert: true
      })
    }).catch(() => {});
    return;
  }

  // Acknowledge immediately
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: queryId,
      text: action === 'approve' ? 'Perintah disetujui, menjalankan...' : 'Perintah ditolak.'
    })
  }).catch(() => {});

  // Update the original markup text to reflect selection
  const decisionText = action === 'approve' ? '🟢 Disetujui' : '🔴 Ditolak';
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `⚠️ *Permintaan Eksekusi Perintah (Status: ${decisionText}):*\n\`\`\`bash\n${pending.command}\n\`\`\``,
      parse_mode: 'Markdown'
    })
  }).catch(() => {});

  // Resolve the promise waiting inside handleTelegramMessage
  pending.resolve(action === 'approve');
  pendingApprovals.delete(pendingId);
}

async function handleTelegramMessage(token, chatId, userText) {
  try {
    const settings = await getActiveSettings();

    // 1. Retrieve relevant memories (RAG)
    const matchingMemories = await retrieveRelevantMemories(userText, 5, settings.memorySimilarity);

    // 2. Save user message to database (using chatId as sessionId)
    await db.query(
      'INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)',
      [chatId, 'user', userText]
    );

    // 3. Get recent chat logs (last 8 messages for context)
    const historyRes = await db.query(
      `SELECT role, content FROM messages 
       WHERE session_id = $1 
       ORDER BY created_at DESC 
       LIMIT 8`,
      [chatId]
    );
    const shortTermHistory = historyRes.rows.reverse();

    // 4. Construct prompt
    let memoryContext = '';
    if (matchingMemories.length > 0) {
      memoryContext = `Recall these facts about the user / past events:\n${matchingMemories.map(m => `- ${m.content}`).join('\n')}\n\n`;
    }

    // 4b. Determine if web search is needed for Telegram user text
    let webContext = '';
    try {
      const checkPrompt = [
        {
          role: 'system',
          content: 'You are a query classifier. Analyze the user message and determine if it requires looking up real-time information, current events (events or facts after 2024), current weather, today\'s news, or general live web search to answer accurately. Respond ONLY with "YES" or "NO". Do not output anything else.'
        },
        {
          role: 'user',
          content: userText
        }
      ];

      console.log('Telegram Bot: Classifying query for web search...');
      const checkResult = await callLLM(checkPrompt, { ...settings, temperature: 0.0 });
      console.log(`Telegram Bot: Web search classification: ${checkResult.trim()}`);

      if (checkResult.trim().toUpperCase() === 'YES') {
        const extractionPrompt = [
          {
            role: 'system',
            content: 'You are a search query generator. Create a simple, optimized search engine query (2 to 5 words) based on the user\'s message. Output ONLY the search query. Do not include quotes, explanations, or punctuation.'
          },
          {
            role: 'user',
            content: userText
          }
        ];
        const rawSearchQuery = await callLLM(extractionPrompt, { ...settings, temperature: 0.1 });
        const cleanQuery = rawSearchQuery.replace(/["']/g, '').trim();

        const searchResults = await searchWeb(cleanQuery);
        if (searchResults.length > 0) {
          webContext = `Current Web Search Results:\n` +
            searchResults.map(r => `[Title: ${r.title}]\nURL: ${r.link}\nSummary: ${r.snippet}`).join('\n\n') +
            `\n\nUse the above fresh search results to provide a factual, up-to-date response. Cite the URLs if relevant.`;
        }
      }
    } catch (err) {
      console.error('Telegram Bot: Web search preprocessing failed:', err);
    }

    let sshContext = '';
    const isSshConfigured = !!(settings.sshHost && settings.sshUser);
    if (isSshConfigured) {
      sshContext = `\n\nREMOTE CODING & SERVER EXECUTION CAPABILITIES:
You are equipped to write code, inspect files, compile, and execute terminal commands on the user's remote server via SSH.
To execute a command on the remote server, output a command inside the following XML tag:
<ssh_run>YOUR_COMMAND_HERE</ssh_run>

For example, to list the current directory:
<ssh_run>ls -la</ssh_run>

To view the contents of a file:
<ssh_run>cat src/main.js</ssh_run>

To create or overwrite a file:
<ssh_run>cat << 'EOF' > test.py
print("Hello from PA")
EOF</ssh_run>

To run or compile a file:
<ssh_run>python3 test.py</ssh_run>

IMPORTANT RULES:
1. Always output exactly one <ssh_run> tag per message. Once you output the tag, STOP generating text. The system will execute the command and return the output inside <ssh_output> tags.
2. After receiving the output, you can choose to output another command or present your final answer.
3. Be careful with command outputs. If you execute a script, ensure it finishes or has a reasonable timeout.
4. Try to write files programmatically using non-interactive tools (like 'cat << "EOF" > path'). Avoid tools like nano, vim, or interactive prompts.
5. If the user asks you to write code, deploy something, or fix an issue, proactively use these tools to perform the task!`;
    }

    const systemMessage = {
      role: 'system',
      content: `${settings.systemPrompt}\n\n${memoryContext}${webContext}${sshContext}\n\nPlease use the recalled facts, web search results, or remote execution outputs if they are relevant to answer the user's message.`
    };

    let activeMessages = [
      systemMessage,
      ...shortTermHistory.map(h => ({ role: h.role, content: h.content }))
    ];

    if (isSshConfigured) {
      activeMessages.push({
        role: 'system',
        content: 'REMINDER: If the user is asking you to list files, read/write/compile/run code, or run any terminal command on the server, you MUST use the <ssh_run>COMMAND</ssh_run> tag to execute it. Do NOT make up or simulate the output. You must execute the real command to answer.'
      });
    }

    let loopCount = 0;
    const maxLoops = 5;
    let finalBotResponse = '';

    const sendTyping = () => {
      fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' })
      }).catch(() => {});
    };

    while (loopCount < maxLoops) {
      sendTyping();
      console.log(`Telegram Bot: Executing loop step ${loopCount + 1}...`);
      const { content, usage } = await callLLMWithUsage(activeMessages, settings);

      finalBotResponse = content;

      const sshMatch = content.match(/<ssh_run>([\s\S]*?)<\/ssh_run>/);
      if (sshMatch && isSshConfigured) {
        const command = sshMatch[1].trim();
        console.log(`Telegram Bot: LLM requested SSH command execution: ${command}`);

        // Save LLM's action to DB
        await db.query(
          'INSERT INTO messages (session_id, role, content, prompt_tokens, completion_tokens) VALUES ($1, $2, $3, $4, $5)',
          [chatId, 'assistant', content, usage.prompt_tokens, usage.completion_tokens]
        );

        // Generate unique pending approval ID
        const pendingId = `ssh_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        
        let resolveApproval;
        const approvalPromise = new Promise((resolve) => {
          resolveApproval = resolve;
        });

        // Prompt the user on Telegram with inline keyboard
        const promptRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `⚠️ *Asisten ingin menjalankan perintah berikut di server:*\n\`\`\`bash\n${command}\n\`\`\``,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Setujui (Run)', callback_data: `approve:${pendingId}` },
                  { text: '❌ Tolak (Cancel)', callback_data: `reject:${pendingId}` }
                ]
              ]
            }
          })
        });

        let messageObjId = null;
        if (promptRes.ok) {
          const promptData = await promptRes.json();
          messageObjId = promptData.result?.message_id;
        }

        // Set timeout to auto-reject after 5 minutes (300,000 ms)
        const timeoutId = setTimeout(() => {
          if (pendingApprovals.has(pendingId)) {
            if (messageObjId) {
              fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: chatId,
                  message_id: messageObjId,
                  text: `⚠️ *Permintaan Eksekusi Perintah (Kedaluwarsa):*\n\`\`\`bash\n${command}\n\`\`\``,
                  parse_mode: 'Markdown'
                })
              }).catch(() => {});
            }
            resolveApproval(false);
            pendingApprovals.delete(pendingId);
          }
        }, 300000);

        // Store resolve details
        pendingApprovals.set(pendingId, {
          command,
          resolve: (val) => {
            clearTimeout(timeoutId);
            resolveApproval(val);
          },
          chatId
        });

        // Await user's button action
        const isApproved = await approvalPromise;

        let toolResultMessage = '';
        if (isApproved) {
          // Send running status to Telegram
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: `🛠️ *Running SSH command...*`,
              parse_mode: 'Markdown'
            })
          }).catch(() => {});

          // Execute remote command
          const execResult = await executeRemoteCommand(command, settings);
          const outputText = `Command: ${command}\nExit Code: ${execResult.code}\nStdout:\n${execResult.stdout}\nStderr:\n${execResult.stderr}`;

          toolResultMessage = `<ssh_output>\n${outputText}\n</ssh_output>`;

          // Send execution result update
          let telegramResultSnippet = execResult.stdout || execResult.stderr || '(No Output)';
          if (telegramResultSnippet.length > 1000) {
            telegramResultSnippet = telegramResultSnippet.slice(0, 1000) + '\n\n... (output truncated)';
          }
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: `📝 *Execution Output (Code ${execResult.code}):*\n\`\`\`\n${telegramResultSnippet}\n\`\`\``,
              parse_mode: 'Markdown'
            })
          }).catch(() => {});
        } else {
          // Rejection branch
          toolResultMessage = `<ssh_output>\nExecution rejected by user. Command was not run.\n</ssh_output>`;
        }

        // Save results to DB
        await db.query(
          'INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)',
          [chatId, 'user', toolResultMessage]
        );

        // Append to active context
        activeMessages.push({ role: 'assistant', content: content });
        activeMessages.push({
          role: 'user',
          content: isApproved 
            ? `${toolResultMessage}\n\nPlease inspect the output and proceed. If you have finished the user's task, respond to the user. If you need to run another command, output another <ssh_run> tag.`
            : `${toolResultMessage}\n\nThe user rejected the execution of this command. Do not try running it again unless they change their mind. Please formulate an alternative approach or explain that the command was rejected.`
        });

        loopCount++;
      } else {
        // Final response
        await db.query(
          'INSERT INTO messages (session_id, role, content, prompt_tokens, completion_tokens) VALUES ($1, $2, $3, $4, $5)',
          [chatId, 'assistant', content, usage.prompt_tokens, usage.completion_tokens]
        );

        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: content
          })
        });
        break;
      }
    }

    // Extract memories in background
    extractAndStoreMemories(userText, finalBotResponse, settings);

  } catch (error) {
    console.error('Error handling Telegram message:', error);
  }
}
