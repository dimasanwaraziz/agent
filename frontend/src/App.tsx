import React, { useState, useEffect, useRef } from 'react';
import { 
  MessageSquare, 
  Database, 
  Settings, 
  Send, 
  Trash2, 
  Cpu, 
  Plus, 
  Loader2,
  RefreshCw,
  MemoryStick
} from 'lucide-react';
import './App.css';

// API Config - use direct backend during Vite dev (port 5173), otherwise route through nginx proxy (/api)
const API_BASE = window.location.port === '5173' 
  ? 'http://localhost:5000/api' 
  : '/api';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
}

interface Memory {
  id: number;
  content: string;
  created_at: string;
}

interface Status {
  status: string;
  dbConnected: boolean;
  llmConnected: boolean;
  llmError: string | null;
  config: {
    apiBaseUrl: string;
    model: string;
  };
}

interface AgentSettings {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  memorySimilarity: number;
  telegramBotToken: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'chat' | 'memories' | 'settings'>('chat');
  const [sessionId] = useState<string>(() => {
    // Persistent sessionId in localStorage to keep session across refreshes
    const saved = localStorage.getItem('agent_session_id');
    if (saved) return saved;
    const newId = crypto.randomUUID();
    localStorage.setItem('agent_session_id', newId);
    return newId;
  });

  // Status Check State
  const [status, setStatus] = useState<Status | null>(null);
  const [checkingStatus, setCheckingStatus] = useState<boolean>(false);

  // Chat State
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState<string>('');
  const [sendingChat, setSendingChat] = useState<boolean>(false);
  const [retrievedMemories, setRetrievedMemories] = useState<string[]>([]);
  const chatHistoryRef = useRef<HTMLDivElement>(null);

  // Memories State
  const [memories, setMemories] = useState<Memory[]>([]);
  const [newMemory, setNewMemory] = useState<string>('');
  const [savingMemory, setSavingMemory] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Settings State
  const [settings, setSettings] = useState<AgentSettings>({
    apiBaseUrl: '',
    apiKey: '',
    model: '',
    systemPrompt: '',
    temperature: 0.7,
    memorySimilarity: 0.4,
    telegramBotToken: ''
  });
  const [savingSettings, setSavingSettings] = useState<boolean>(false);
  const [settingsStatusMessage, setSettingsStatusMessage] = useState<string>('');

  // 1. Initial Checks and Fetch Data
  const checkStatus = async () => {
    setCheckingStatus(true);
    try {
      const res = await fetch(`${API_BASE}/status`);
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      } else {
        setStatus(null);
      }
    } catch {
      setStatus(null);
    } finally {
      setCheckingStatus(false);
    }
  };

  const fetchMessages = async () => {
    try {
      const res = await fetch(`${API_BASE}/messages?sessionId=${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data);
      }
    } catch (err) {
      console.error('Error fetching messages:', err);
    }
  };

  const fetchMemories = async () => {
    try {
      const res = await fetch(`${API_BASE}/memories`);
      if (res.ok) {
        const data = await res.json();
        setMemories(data);
      }
    } catch (err) {
      console.error('Error fetching memories:', err);
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await fetch(`${API_BASE}/settings`);
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
      }
    } catch (err) {
      console.error('Error fetching settings:', err);
    }
  };

  useEffect(() => {
    checkStatus();
    fetchMessages();
    fetchMemories();
    fetchSettings();

    // Check status every 7 seconds
    const interval = setInterval(checkStatus, 7000);
    return () => clearInterval(interval);
  }, []);

  // Scroll to bottom of chat safely using container scrollTop to avoid browser window scrolling bugs
  useEffect(() => {
    if (chatHistoryRef.current) {
      chatHistoryRef.current.scrollTop = chatHistoryRef.current.scrollHeight;
    }
  }, [messages, sendingChat]);

  // 2. Chat Operations
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim() || sendingChat) return;

    const userText = inputMessage.trim();
    setInputMessage('');
    
    // Add user message locally
    setMessages(prev => [...prev, { role: 'user', content: userText }]);
    setSendingChat(true);

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          message: userText
        })
      });

      if (res.ok) {
        const data = await res.json();
        setMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
        // Update memories active during this interaction
        if (data.memoriesUsed) {
          setRetrievedMemories(data.memoriesUsed.map((m: any) => m.content));
        }
        // Refresh memories list in the background (as new ones may have been extracted)
        setTimeout(fetchMemories, 1500);
      } else {
        const errorData = await res.json();
        setMessages(prev => [...prev, { 
          role: 'assistant', 
          content: `⚠️ Error: ${errorData.error || 'Failed to get response from agent.'}` 
        }]);
      }
    } catch (err: any) {
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: `⚠️ Network error: ${err.message || 'Could not connect to assistant backend.'}` 
      }]);
    } finally {
      setSendingChat(false);
    }
  };

  const handleClearHistory = async () => {
    if (!confirm('Clear all conversation messages?')) return;
    try {
      const res = await fetch(`${API_BASE}/messages?sessionId=${sessionId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        setMessages([]);
        setRetrievedMemories([]);
      }
    } catch (err) {
      console.error('Error clearing history:', err);
    }
  };

  // 3. Memories Operations
  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMemory.trim() || savingMemory) return;

    setSavingMemory(true);
    try {
      const res = await fetch(`${API_BASE}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newMemory.trim() })
      });
      if (res.ok) {
        setNewMemory('');
        fetchMemories();
      }
    } catch (err) {
      console.error('Error adding memory:', err);
    } finally {
      setSavingMemory(false);
    }
  };

  const handleDeleteMemory = async (id: number) => {
    try {
      const res = await fetch(`${API_BASE}/memories/${id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        fetchMemories();
      }
    } catch (err) {
      console.error('Error deleting memory:', err);
    }
  };

  // 4. Settings Operations
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsStatusMessage('');

    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        setSettingsStatusMessage('✅ Settings saved successfully!');
        checkStatus();
      } else {
        setSettingsStatusMessage('❌ Failed to save settings.');
      }
    } catch (err: any) {
      setSettingsStatusMessage(`❌ Error: ${err.message}`);
    } finally {
      setSavingSettings(false);
    }
  };

  // Filter memories list based on search bar query
  const filteredMemories = memories.filter(m => 
    m.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="dashboard">
      <div className="bg-glow glow-1"></div>
      <div className="bg-glow glow-2"></div>

      {/* Sidebar Panel */}
      <div className="sidebar glass">
        <div className="logo-container">
          <Cpu className="logo-icon" size={28} />
          <span className="logo-text">ANTIGRAVITY PA</span>
        </div>

        <div className="nav-menu">
          <button 
            className={`nav-item ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => setActiveTab('chat')}
          >
            <MessageSquare size={18} />
            Asisten Chat
          </button>
          <button 
            className={`nav-item ${activeTab === 'memories' ? 'active' : ''}`}
            onClick={() => setActiveTab('memories')}
          >
            <MemoryStick size={18} />
            Daya Ingat (Memori)
          </button>
          <button 
            className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Settings size={18} />
            Konfigurasi & Setup
          </button>
        </div>

        {/* Status panel */}
        <div className="status-panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span className="status-title">System Health</span>
            <button 
              onClick={checkStatus} 
              disabled={checkingStatus}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
            >
              <RefreshCw size={12} className={checkingStatus ? 'spin' : ''} />
            </button>
          </div>
          <div className="status-row">
            <span>Database Vector:</span>
            <div className="status-indicator">
              <span className={`dot ${status?.dbConnected ? 'connected' : 'disconnected'}`}></span>
              <span>{status?.dbConnected ? 'OK' : 'Error'}</span>
            </div>
          </div>
          <div className="status-row">
            <span>LLM API:</span>
            <div className="status-indicator">
              <span className={`dot ${status?.llmConnected ? 'connected' : 'disconnected'}`}></span>
              <span>{status?.llmConnected ? 'Connected' : 'Offline'}</span>
            </div>
          </div>
          {status && !status.llmConnected && (
            <div style={{ fontSize: '0.75rem', color: 'var(--error)', marginTop: '6px', wordBreak: 'break-all' }}>
              Connection: {status.llmError || 'Cannot ping endpoint'}
            </div>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="main-content glass">
        
        {/* Tab 1: Chat interface */}
        {activeTab === 'chat' && (
          <div className="chat-container">
            <div className="chat-messages-wrapper">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Personal Assistant Chat</h2>
                {messages.length > 0 && (
                  <button onClick={handleClearHistory} className="delete-btn" title="Hapus chat history">
                    <Trash2 size={18} />
                  </button>
                )}
              </div>

              <div className="chat-history" ref={chatHistoryRef}>
                {messages.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary)' }}>
                    <MessageSquare size={48} style={{ opacity: 0.2, marginBottom: '16px' }} />
                    <p style={{ fontWeight: 500 }}>Halo! Saya asisten personal Anda.</p>
                    <p style={{ fontSize: '0.85rem', opacity: 0.7 }}>Ketik pesan untuk memulai obrolan. Saya akan mengingat fakta penting dari obrolan kita secara otomatis.</p>
                  </div>
                ) : (
                  messages.map((msg, i) => (
                    <div key={i} className={`message-bubble ${msg.role}`}>
                      {msg.content}
                    </div>
                  ))
                )}
                {sendingChat && (
                  <div className="message-bubble assistant">
                    <div className="loading-dots">
                      <div className="loading-dot"></div>
                      <div className="loading-dot"></div>
                      <div className="loading-dot"></div>
                    </div>
                  </div>
                )}
              </div>

              <form onSubmit={handleSendMessage} className="chat-input-area">
                <input 
                  type="text" 
                  className="chat-input"
                  placeholder="Kirim instruksi atau obrolan ke asisten..."
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  disabled={sendingChat}
                />
                <button type="submit" className="send-btn" disabled={sendingChat || !inputMessage.trim()}>
                  <Send size={18} />
                </button>
              </form>
            </div>

            {/* Right Context / Memory retrieval visualizer */}
            <div className="memory-sidebar">
              <div className="memory-sidebar-title">
                <Database size={16} style={{ color: 'var(--primary-color)' }} />
                <span>Memori Terpanggil (RAG)</span>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Fakta dari memori jangka panjang yang dipanggil pgvector untuk context obrolan terakhir:
              </p>
              
              {retrievedMemories.length === 0 ? (
                <div className="memory-empty-state">
                  Belum ada memori terpanggil untuk pesan ini.
                </div>
              ) : (
                retrievedMemories.map((mem, index) => (
                  <div key={index} className="memory-item-rag">
                    {mem}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Tab 2: Memory Manager */}
        {activeTab === 'memories' && (
          <div className="memories-panel">
            <div className="memories-header">
              <div className="memories-title-section">
                <h2>Daya Ingat Jangka Panjang</h2>
                <p>Memori yang disimpan asisten secara otomatis (atau manual) dan diindex via pgvector.</p>
              </div>
            </div>

            <form onSubmit={handleAddMemory} className="add-memory-form">
              <input 
                type="text" 
                className="form-control"
                style={{ flexGrow: 1 }}
                placeholder="Tuliskan fakta baru untuk diingat asisten secara manual... (misal: 'User suka minum kopi arabica')"
                value={newMemory}
                onChange={(e) => setNewMemory(e.target.value)}
                disabled={savingMemory}
              />
              <button type="submit" className="send-btn" disabled={savingMemory || !newMemory.trim()} style={{ height: '40px' }}>
                {savingMemory ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
                <span style={{ marginLeft: '8px' }}>Tambah Memori</span>
              </button>
            </form>

            <div style={{ marginTop: '12px' }}>
              <input 
                type="text" 
                className="form-control"
                style={{ width: '100%', maxWidth: '350px' }}
                placeholder="Cari memori..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            {filteredMemories.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)' }}>
                Tidak ada memori yang ditemukan.
              </div>
            ) : (
              <div className="memory-list">
                {filteredMemories.map((mem) => (
                  <div key={mem.id} className="memory-card glass">
                    <div className="memory-card-content">
                      {mem.content}
                    </div>
                    <div className="memory-card-footer">
                      <span>{new Date(mem.created_at).toLocaleDateString()}</span>
                      <button onClick={() => handleDeleteMemory(mem.id)} className="delete-btn" title="Hapus memori">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Configuration Settings */}
        {activeTab === 'settings' && (
          <div className="settings-panel">
            <div className="memories-title-section">
              <h2>Setup & Hubungkan AI</h2>
              <p>Atur API provider Anda. Mendukung Ollama (lokal), OpenRouter, Groq, OpenAI, LM Studio, dan API kompatibel OpenAI lainnya.</p>
            </div>

            <form onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div className="settings-section">
                <div className="settings-section-title">
                  <Cpu size={18} style={{ color: 'var(--primary-color)' }} />
                  <span>Koneksi Model AI</span>
                </div>

                <div className="form-group">
                  <label htmlFor="apiBaseUrl">LLM API Base URL (OpenAI-compatible)</label>
                  <input 
                    id="apiBaseUrl"
                    type="text" 
                    className="form-control"
                    placeholder="Contoh: http://localhost:11434/v1 (Ollama) atau https://api.openai.com/v1"
                    value={settings.apiBaseUrl}
                    onChange={(e) => setSettings({ ...settings, apiBaseUrl: e.target.value })}
                    required
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="apiKey">API Key (Biarkan kosong jika lokal/Ollama)</label>
                  <input 
                    id="apiKey"
                    type="password" 
                    className="form-control"
                    placeholder="Masukkan API key Anda"
                    value={settings.apiKey}
                    onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="model">Nama Model LLM</label>
                  <input 
                    id="model"
                    type="text" 
                    className="form-control"
                    placeholder="Contoh: llama3, qwen2.5, gpt-4o-mini"
                    value={settings.model}
                    onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">
                  <Database size={18} style={{ color: 'var(--accent-color)' }} />
                  <span>Konfigurasi Agent & Memori</span>
                </div>

                <div className="form-group">
                  <label htmlFor="systemPrompt">System Prompt (Instruksi Dasar Agent)</label>
                  <textarea 
                    id="systemPrompt"
                    className="form-control"
                    rows={4}
                    style={{ resize: 'vertical' }}
                    value={settings.systemPrompt}
                    onChange={(e) => setSettings({ ...settings, systemPrompt: e.target.value })}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>LLM Temperature (Kreativitas)</label>
                  <div className="slider-container">
                    <input 
                      type="range" 
                      min="0" 
                      max="1.5" 
                      step="0.1"
                      className="form-control"
                      style={{ flexGrow: 1, padding: 0 }}
                      value={settings.temperature}
                      onChange={(e) => setSettings({ ...settings, temperature: parseFloat(e.target.value) })}
                    />
                    <span className="slider-val">{settings.temperature}</span>
                  </div>
                </div>

                <div className="form-group">
                  <label>Batas Kesamaan Memori RAG (Memory Similarity Threshold)</label>
                  <div className="slider-container">
                    <input 
                      type="range" 
                      min="0.1" 
                      max="0.9" 
                      step="0.05"
                      className="form-control"
                      style={{ flexGrow: 1, padding: 0 }}
                      value={settings.memorySimilarity}
                      onChange={(e) => setSettings({ ...settings, memorySimilarity: parseFloat(e.target.value) })}
                    />
                    <span className="slider-val">{settings.memorySimilarity}</span>
                  </div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Nilai lebih tinggi = pencocokan memori lebih ketat / relevan. Default: 0.4.
                  </span>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">
                  <MessageSquare size={18} style={{ color: 'var(--primary-color)' }} />
                  <span>Integrasi Bot Telegram</span>
                </div>

                <div className="form-group">
                  <label htmlFor="telegramBotToken">Telegram Bot Token (Optional)</label>
                  <input 
                    id="telegramBotToken"
                    type="password" 
                    className="form-control"
                    placeholder="Contoh: 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
                    value={settings.telegramBotToken}
                    onChange={(e) => setSettings({ ...settings, telegramBotToken: e.target.value })}
                  />
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: '1.4', marginTop: '6px' }}>
                    Untuk menghubungkan PA ini ke Telegram:<br />
                    1. Buat bot baru di Telegram melalui chat dengan <strong>@BotFather</strong>.<br />
                    2. Salin token API yang diberikan dan tempel di atas.<br />
                    3. Simpan konfigurasi ini, lalu mulai chat dengan bot Telegram Anda! Memori jangka panjang akan tetap dibagikan secara otomatis.
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <button type="submit" className="save-settings-btn" disabled={savingSettings}>
                  {savingSettings ? 'Menyimpan...' : 'Simpan Setup'}
                </button>
                {settingsStatusMessage && (
                  <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>
                    {settingsStatusMessage}
                  </span>
                )}
              </div>
            </form>
          </div>
        )}

      </div>
    </div>
  );
}
