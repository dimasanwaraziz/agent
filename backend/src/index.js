import express from 'express';
import cors from 'cors';
import * as db from './db.js';
import { callLLM, extractAndStoreMemories } from './llm.js';
import { retrieveRelevantMemories } from './memoryService.js';
import { initTelegramBot } from './telegram.js';

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
    telegramBotToken: currentSettings.telegramBotToken || ''
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
    const { apiBaseUrl, apiKey, model, systemPrompt, temperature, memorySimilarity, telegramBotToken } = req.body;
    
    if (apiBaseUrl !== undefined) await db.saveSetting('apiBaseUrl', apiBaseUrl);
    if (apiKey !== undefined) await db.saveSetting('apiKey', apiKey);
    if (model !== undefined) await db.saveSetting('model', model);
    if (systemPrompt !== undefined) await db.saveSetting('systemPrompt', systemPrompt);
    if (temperature !== undefined) await db.saveSetting('temperature', temperature.toString());
    if (memorySimilarity !== undefined) await db.saveSetting('memorySimilarity', memorySimilarity.toString());
    if (telegramBotToken !== undefined) await db.saveSetting('telegramBotToken', telegramBotToken);

    // Restart Telegram Bot with new settings
    initTelegramBot();

    res.json({ message: 'Settings saved successfully' });
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
      'SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY created_at ASC',
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

    const systemMessage = {
      role: 'system',
      content: `${settings.systemPrompt}\n\n${memoryContext}Please use the recalled facts if they are relevant to answer the user's message. Do not explicitly state "Based on the retrieved facts" or similar, just answer naturally as if you remember them yourself.`
    };

    // E. Assemble full messages array
    // Map existing history to correct API format, ensuring system prompt is first
    const llmMessages = [
      systemMessage,
      ...shortTermHistory.map(m => ({ role: m.role, content: m.content }))
    ];

    // F. Call LLM
    const assistantResponse = await callLLM(llmMessages, settings);

    // G. Save Assistant Message to DB
    await db.query(
      'INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)',
      [sessionId, 'assistant', assistantResponse]
    );

    // H. Schedule background memory extraction (do not await to speed up response)
    extractAndStoreMemories(message, assistantResponse, settings);

    res.json({
      response: assistantResponse,
      memoriesUsed: matchingMemories
    });

  } catch (error) {
    console.error('Chat endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Backend server running on port ${port}`);
});
