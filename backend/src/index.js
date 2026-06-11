import express from 'express';
import cors from 'cors';
import * as db from './db.js';
import { callLLM, callLLMWithUsage, extractAndStoreMemories } from './llm.js';
import { retrieveRelevantMemories } from './memoryService.js';
import { initTelegramBot } from './telegram.js';
import { searchWeb } from './search.js';
import { executeRemoteCommand } from './sshExecutor.js';

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Initialize Database on Startup
db.initDb()
  .then(() => {
    initTelegramBot();
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

// Default Settings Helper
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
    inputCostPerMillion: currentSettings.inputCostPerMillion !== undefined ? parseFloat(currentSettings.inputCostPerMillion) : 0.15,
    outputCostPerMillion: currentSettings.outputCostPerMillion !== undefined ? parseFloat(currentSettings.outputCostPerMillion) : 0.60,
    sshHost: currentSettings.sshHost || '',
    sshUser: currentSettings.sshUser || '',
    sshPort: currentSettings.sshPort || '22',
    sshPassword: currentSettings.sshPassword || '',
    sshPrivateKey: currentSettings.sshPrivateKey || ''
  };
}

// 1. Status Check
app.get('/api/status', async (req, res) => {
  try {
    // Check DB
    await db.query('SELECT 1');
    const settings = await getActiveSettings();
    
    // Check LLM endpoint status
    let llmConnected = false;
    let llmError = null;
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 3000);
      const url = `${settings.apiBaseUrl.replace(/\/$/, '')}/models`;
      const response = await fetch(url, {
        method: 'GET',
        headers: settings.apiKey ? { 'Authorization': `Bearer ${settings.apiKey}` } : {},
        signal: controller.signal
      });
      clearTimeout(id);
      llmConnected = response.ok;
    } catch (err) {
      llmError = err.message;
    }

    res.json({
      status: 'healthy',
      dbConnected: true,
      llmConnected,
      llmError,
      config: {
        apiBaseUrl: settings.apiBaseUrl,
        model: settings.model
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      dbConnected: false,
      error: error.message
    });
  }
});

// 2. Settings Endpoint
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await getActiveSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { apiBaseUrl, apiKey, model, systemPrompt, temperature, memorySimilarity, telegramBotToken, inputCostPerMillion, outputCostPerMillion, sshHost, sshUser, sshPort, sshPassword, sshPrivateKey } = req.body;
    
    if (apiBaseUrl !== undefined) await db.saveSetting('apiBaseUrl', apiBaseUrl);
    if (apiKey !== undefined) await db.saveSetting('apiKey', apiKey);
    if (model !== undefined) await db.saveSetting('model', model);
    if (systemPrompt !== undefined) await db.saveSetting('systemPrompt', systemPrompt);
    if (temperature !== undefined) await db.saveSetting('temperature', temperature.toString());
    if (memorySimilarity !== undefined) await db.saveSetting('memorySimilarity', memorySimilarity.toString());
    if (telegramBotToken !== undefined) await db.saveSetting('telegramBotToken', telegramBotToken);
    if (inputCostPerMillion !== undefined) await db.saveSetting('inputCostPerMillion', inputCostPerMillion.toString());
    if (outputCostPerMillion !== undefined) await db.saveSetting('outputCostPerMillion', outputCostPerMillion.toString());
    if (sshHost !== undefined) await db.saveSetting('sshHost', sshHost);
    if (sshUser !== undefined) await db.saveSetting('sshUser', sshUser);
    if (sshPort !== undefined) await db.saveSetting('sshPort', sshPort.toString());
    if (sshPassword !== undefined) await db.saveSetting('sshPassword', sshPassword);
    if (sshPrivateKey !== undefined) await db.saveSetting('sshPrivateKey', sshPrivateKey);

    // Restart Telegram Bot with new settings
    initTelegramBot();

    res.json({ message: 'Settings saved successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2.2 Token Usage Stats Endpoint
app.get('/api/usage', async (req, res) => {
  try {
    const settings = await getActiveSettings();
    const result = await db.query(
      `SELECT 
         COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens
       FROM messages`
    );

    const promptTokens = parseInt(result.rows[0].total_prompt_tokens);
    const completionTokens = parseInt(result.rows[0].total_completion_tokens);
    const totalTokens = promptTokens + completionTokens;

    const inputCost = (promptTokens / 1000000) * settings.inputCostPerMillion;
    const outputCost = (completionTokens / 1000000) * settings.outputCostPerMillion;
    const totalCost = inputCost + outputCost;

    res.json({
      promptTokens,
      completionTokens,
      totalTokens,
      totalCost: parseFloat(totalCost.toFixed(6)),
      inputCostPerMillion: settings.inputCostPerMillion,
      outputCostPerMillion: settings.outputCostPerMillion
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2.3 SSH Test Connection Endpoint
app.post('/api/ssh/test', async (req, res) => {
  try {
    const settings = await getActiveSettings();
    
    // Check if host and user are set (either passed in request body or loaded from db)
    const host = req.body.sshHost !== undefined ? req.body.sshHost : settings.sshHost;
    const user = req.body.sshUser !== undefined ? req.body.sshUser : settings.sshUser;
    
    if (!host || !user) {
      return res.status(400).json({ success: false, error: 'SSH Host and User are required to test connection.' });
    }

    const config = {
      sshHost: host,
      sshUser: user,
      sshPort: req.body.sshPort !== undefined ? req.body.sshPort : settings.sshPort,
      sshPassword: req.body.sshPassword !== undefined ? req.body.sshPassword : settings.sshPassword,
      sshPrivateKey: req.body.sshPrivateKey !== undefined ? req.body.sshPrivateKey : settings.sshPrivateKey
    };

    console.log(`Testing SSH connection to: ${user}@${host}`);
    // Run simple diagnostics command: print system info
    const testResult = await executeRemoteCommand('uname -a && echo "SSH connection check passed!"', config);
    
    if (testResult.code === 0) {
      res.json({
        success: true,
        output: testResult.stdout,
        error: null
      });
    } else {
      res.json({
        success: false,
        output: null,
        error: testResult.stderr || 'SSH connection failed.'
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Memories Endpoints
app.get('/api/memories', async (req, res) => {
  try {
    const result = await db.query('SELECT id, content, created_at FROM memories ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/memories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM memories WHERE id = $1', [id]);
    res.json({ message: 'Memory deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/memories', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content is required' });
    
    const { getEmbedding } = await import('./embeddings.js');
    const vector = await getEmbedding(content);
    const vectorStr = `[${vector.join(',')}]`;
    
    const result = await db.query(
      'INSERT INTO memories (content, embedding) VALUES ($1, $2) RETURNING id, content, created_at',
      [content, vectorStr]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Messages History
app.get('/api/messages', async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const result = await db.query(
      'SELECT role, content, prompt_tokens, completion_tokens, created_at FROM messages WHERE session_id = $1 ORDER BY created_at ASC',
      [sessionId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/messages', async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    await db.query('DELETE FROM messages WHERE session_id = $1', [sessionId]);
    res.json({ message: 'Chat history cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Chat Endpoint with RAG Memory, SSH Coding Loop & Background Fact Extraction
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required' });
    }

    const settings = await getActiveSettings();

    // A. Retrieve relevant memories (RAG)
    const matchingMemories = await retrieveRelevantMemories(
      message, 
      5, 
      settings.memorySimilarity
    );

    // B. Save User Message to DB
    await db.query(
      'INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)',
      [sessionId, 'user', message]
    );

    // C. Get Recent Chat History (Last 10 messages for short-term context)
    const historyRes = await db.query(
      `SELECT role, content FROM messages 
       WHERE session_id = $1 
       ORDER BY created_at DESC 
       LIMIT 10`,
      [sessionId]
    );
    const shortTermHistory = historyRes.rows.reverse();

    // D. Construct LLM Prompt context
    let memoryContext = '';
    if (matchingMemories.length > 0) {
      memoryContext = `Recall these facts about the user / past events:\n${matchingMemories.map(m => `- ${m.content}`).join('\n')}\n\n`;
    }

    // D2. Determine if web search is needed
    let webContext = '';
    try {
      const checkPrompt = [
        {
          role: 'system',
          content: 'You are a query classifier. Analyze the user message and determine if it requires looking up real-time information, current events (events or facts after 2024), current weather, today\'s news, or general live web search to answer accurately. Respond ONLY with "YES" or "NO". Do not output anything else.'
        },
        {
          role: 'user',
          content: message
        }
      ];

      console.log('Classifying query for web search...');
      const checkResult = await callLLM(checkPrompt, { ...settings, temperature: 0.0 });
      console.log(`Web search classification: ${checkResult.trim()}`);

      if (checkResult.trim().toUpperCase() === 'YES') {
        const extractionPrompt = [
          {
            role: 'system',
            content: 'You are a search query generator. Create a simple, optimized search engine query (2 to 5 words) based on the user\'s message. Output ONLY the search query. Do not include quotes, explanations, or punctuation.'
          },
          {
            role: 'user',
            content: message
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
      console.error('Web search preprocessing failed:', err);
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

    // E. Assemble full messages array
    let activeMessages = [
      systemMessage,
      ...shortTermHistory.map(m => ({ role: m.role, content: m.content }))
    ];

    if (isSshConfigured) {
      activeMessages.push({
        role: 'system',
        content: 'REMINDER: If the user is asking you to list files, read/write/compile/run code, or run any terminal command on the server, you MUST use the <ssh_run>COMMAND</ssh_run> tag to execute it. Do NOT make up or simulate the output. You must execute the real command to answer.'
      });
    }

    let loopCount = 0;
    const maxLoops = 5;
    let finalAssistantResponse = '';
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    while (loopCount < maxLoops) {
      console.log(`Executing chat loop step ${loopCount + 1}...`);
      const { content, usage } = await callLLMWithUsage(activeMessages, settings);
      totalUsage.prompt_tokens += usage.prompt_tokens;
      totalUsage.completion_tokens += usage.completion_tokens;
      totalUsage.total_tokens += usage.total_tokens;

      finalAssistantResponse = content;

      const sshMatch = content.match(/<ssh_run>([\s\S]*?)<\/ssh_run>/);
      if (sshMatch && isSshConfigured) {
        const command = sshMatch[1].trim();
        console.log(`LLM requested remote SSH execution: ${command}`);

        // Save LLM's action to DB
        await db.query(
          'INSERT INTO messages (session_id, role, content, prompt_tokens, completion_tokens) VALUES ($1, $2, $3, $4, $5)',
          [sessionId, 'assistant', content, usage.prompt_tokens, usage.completion_tokens]
        );

        // Execute remote command
        const execResult = await executeRemoteCommand(command, settings);
        const outputText = `Command: ${command}\nExit Code: ${execResult.code}\nStdout:\n${execResult.stdout}\nStderr:\n${execResult.stderr}`;

        // Save command execution results to DB as a system/user context update
        const toolResultMessage = `<ssh_output>\n${outputText}\n</ssh_output>`;
        await db.query(
          'INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)',
          [sessionId, 'user', toolResultMessage]
        );

        // Append to activeMessages context
        activeMessages.push({ role: 'assistant', content: content });
        activeMessages.push({
          role: 'user',
          content: `${toolResultMessage}\n\nPlease inspect the output and proceed. If you have finished the user's task, respond to the user. If you need to run another command, output another <ssh_run> tag.`
        });

        loopCount++;
      } else {
        // No command requested, or SSH not configured. This is the final response.
        await db.query(
          'INSERT INTO messages (session_id, role, content, prompt_tokens, completion_tokens) VALUES ($1, $2, $3, $4, $5)',
          [sessionId, 'assistant', content, usage.prompt_tokens, usage.completion_tokens]
        );
        break;
      }
    }

    // H. Schedule background memory extraction (do not await to speed up response)
    extractAndStoreMemories(message, finalAssistantResponse, settings);

    res.json({
      response: finalAssistantResponse,
      memoriesUsed: matchingMemories,
      usage: totalUsage
    });

  } catch (error) {
    console.error('Chat endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 6. Analytics Endpoint
app.get('/api/analytics', async (req, res) => {
  try {
    const { interval } = req.query; // 'hour' or 'day'
    const bucket = interval === 'hour' ? 'hour' : 'day';
    const limit = interval === 'hour' ? 24 : 30;

    const result = await db.query(
      `SELECT 
         DATE_TRUNC($1, created_at) AS time_bucket,
         COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total_tokens
       FROM messages
       WHERE role = 'assistant'
       GROUP BY time_bucket
       ORDER BY time_bucket ASC
       LIMIT $2`,
      [bucket, limit]
    );

    res.json(result.rows.map(row => ({
      timeBucket: row.time_bucket,
      promptTokens: parseInt(row.prompt_tokens),
      completionTokens: parseInt(row.completion_tokens),
      totalTokens: parseInt(row.total_tokens)
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Backend server running on port ${port}`);
});
