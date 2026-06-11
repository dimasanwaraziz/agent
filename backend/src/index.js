import express from 'express';
import cors from 'cors';
import * as db from './db.js';
import { callLLM, callLLMWithUsage, extractAndStoreMemories } from './llm.js';
import { retrieveRelevantMemories } from './memoryService.js';
import { initTelegramBot } from './telegram.js';
import { searchWeb } from './search.js';

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
    outputCostPerMillion: currentSettings.outputCostPerMillion !== undefined ? parseFloat(currentSettings.outputCostPerMillion) : 0.60
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
    const { apiBaseUrl, apiKey, model, systemPrompt, temperature, memorySimilarity, telegramBotToken, inputCostPerMillion, outputCostPerMillion } = req.body;
    
    if (apiBaseUrl !== undefined) await db.saveSetting('apiBaseUrl', apiBaseUrl);
    if (apiKey !== undefined) await db.saveSetting('apiKey', apiKey);
    if (model !== undefined) await db.saveSetting('model', model);
    if (systemPrompt !== undefined) await db.saveSetting('systemPrompt', systemPrompt);
    if (temperature !== undefined) await db.saveSetting('temperature', temperature.toString());
    if (memorySimilarity !== undefined) await db.saveSetting('memorySimilarity', memorySimilarity.toString());
    if (telegramBotToken !== undefined) await db.saveSetting('telegramBotToken', telegramBotToken);
    if (inputCostPerMillion !== undefined) await db.saveSetting('inputCostPerMillion', inputCostPerMillion.toString());
    if (outputCostPerMillion !== undefined) await db.saveSetting('outputCostPerMillion', outputCostPerMillion.toString());

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

// 5. Chat Endpoint with RAG Memory & Background Fact Extraction
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

    const systemMessage = {
      role: 'system',
      content: `${settings.systemPrompt}\n\n${memoryContext}${webContext}\n\nPlease use the recalled facts or web search results if they are relevant to answer the user's message. Do not explicitly state "Based on the retrieved facts" or "According to the search results", just answer naturally as if you remember them yourself.`
    };

    // E. Assemble full messages array
    // Map existing history to correct API format, ensuring system prompt is first
    const llmMessages = [
      systemMessage,
      ...shortTermHistory.map(m => ({ role: m.role, content: m.content }))
    ];

    // F. Call LLM with token usage tracking
    const { content: assistantResponse, usage } = await callLLMWithUsage(llmMessages, settings);

    // G. Save Assistant Message and token stats to DB
    await db.query(
      'INSERT INTO messages (session_id, role, content, prompt_tokens, completion_tokens) VALUES ($1, $2, $3, $4, $5)',
      [sessionId, 'assistant', assistantResponse, usage.prompt_tokens, usage.completion_tokens]
    );

    // H. Schedule background memory extraction (do not await to speed up response)
    extractAndStoreMemories(message, assistantResponse, settings);

    res.json({
      response: assistantResponse,
      memoriesUsed: matchingMemories,
      usage
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
