import * as db from './db.js';
import { callLLM, extractAndStoreMemories } from './llm.js';
import { retrieveRelevantMemories } from './memoryService.js';
import { searchWeb } from './search.js';

let isRunning = false;
let abortController = null;

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
    telegramBotToken: currentSettings.telegramBotToken || ''
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

    const systemMessage = {
      role: 'system',
      content: `${settings.systemPrompt}\n\n${memoryContext}${webContext}\n\nPlease use the recalled facts or web search results if they are relevant to answer the user's message. Do not explicitly state "Based on the retrieved facts" or "According to the search results", just answer naturally as if you remember them yourself.`
    };

    const messages = [
      systemMessage,
      ...shortTermHistory.map(h => ({ role: h.role, content: h.content }))
    ];

    // 5. Send typing indicator
    fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    }).catch(() => {});

    // 6. Call LLM
    const botResponse = await callLLM(messages, settings);

    // 7. Save bot response to DB
    await db.query(
      'INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)',
      [chatId, 'assistant', botResponse]
    );

    // 8. Send message to Telegram
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: botResponse
      })
    });

    if (!response.ok) {
      console.error('Failed to send Telegram response message');
    }

    // 9. Extract memories in background
    extractAndStoreMemories(userText, botResponse, settings);

  } catch (error) {
    console.error('Error handling Telegram message:', error);
  }
}
