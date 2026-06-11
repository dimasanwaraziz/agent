# Antigravity PA (Personal Assistant) 🧠

Antigravity PA adalah agen asisten pribadi (personal assistant) modern yang dirancang sebagai pengganti open-source alternatif seperti OpenClaw. Sistem ini dibangun menggunakan JavaScript/TypeScript, Express, React (Vite), dan PostgreSQL dengan ekstensi `pgvector` untuk memberikan **daya ingat jangka panjang yang kuat**.

## Fitur Utama
- **Daya Ingat Kuat (Long-term Memory)**: Secara otomatis mengekstrak fakta penting dari obrolan Anda dan menyimpannya ke database vector.
- **RAG (Retrieval-Augmented Generation)**: Sebelum menjawab, agen memanggil fakta-fakta masa lalu yang relevan menggunakan perbandingan kosinus (cosine similarity) untuk personalisasi respons.
- **Visualisasi Memori Real-Time**: Lihat secara langsung memori apa saja yang dipanggil oleh AI di sidebar chat saat Anda mengobrol.
- **Konektivitas Model Luas**: Terhubung dengan model open-source lokal (Ollama, LM Studio) maupun API pihak ketiga (Groq, OpenRouter, TogetherAI, OpenAI) menggunakan format API kompatibel OpenAI.
- **Zero-Config Local Embeddings**: Menggunakan model `@xenova/transformers` (`all-MiniLM-L6-v2`) di backend untuk memproses embeddings secara lokal dan cepat tanpa biaya API atau konfigurasi tambahan.
- **Dashboard Premium**: Tampilan minimalis, modern, glassmorphic dengan mode gelap default, status konektivitas indikator, dan panel manajemen memori.

---

## Arsitektur Aplikasi
```mermaid
graph TD
    User([Pengguna]) <--> Frontend[Frontend - React Vite]
    Frontend <--> Backend[Backend - Node.js Express]
    Backend <--> Postgres[(PostgreSQL + pgvector)]
    Backend -- Generate Vectors --> LocalMiniLM[Local MiniLM Embedding Model]
    Backend -- Chat Request --> LLM_API[LLM API: Ollama / Groq / OpenAI]
```

---

## Cara Deploy dengan Docker Compose (Sangat Direkomendasikan)

Pastikan Docker dan Docker Compose telah terinstal di sistem Anda.

1. **Jalankan Docker Compose**
   Di direktori utama project, jalankan perintah berikut:
   ```bash
   docker compose up --build -d
   ```
   Perintah ini akan membangun dan menjalankan tiga container:
   - `db`: PostgreSQL dengan ekstensi `pgvector`.
   - `backend`: Server Node.js Express (Port `5000`).
   - `frontend`: Web dashboard statis yang dilayani via Nginx (Port `8080`).

2. **Akses Dashboard**
   Buka browser Anda dan akses:
   [http://localhost:8080](http://localhost:8080)

3. **Lakukan Setup Model AI**
   - Buka tab **Konfigurasi & Setup**.
   - Masukkan **LLM API Base URL**.
     - Jika menggunakan Ollama yang berjalan langsung di host machine (bukan docker): gunakan IP LAN komputer Anda atau `http://host.docker.internal:11434/v1`.
     - Jika menggunakan OpenRouter: `https://openrouter.ai/api/v1` dan masukkan API Key.
     - Jika menggunakan Groq: `https://api.groq.com/openai/v1` dan masukkan API Key.
   - Masukkan **Nama Model LLM** (contoh: `llama3`, `qwen2.5`, atau `gpt-4o-mini`).
   - Klik **Simpan Setup**. Indikator status di sidebar kiri akan berubah menjadi hijau jika berhasil terhubung!

---

## Pengembangan Lokal (Tanpa Docker)

Jika Anda ingin menjalankan aplikasi di lingkungan pengembangan lokal tanpa Docker:

### Prerequisites
1. Pastikan PostgreSQL terinstal dan ekstensi `vector` sudah di-enable (`CREATE EXTENSION IF NOT EXISTS vector`).
2. Buat database kosong bernama `agent_db`.

### Langkah-langkah
1. **Setup Backend**
   ```bash
   cd backend
   npm install
   ```
   Buat file `.env` di dalam folder `backend`:
   ```env
   DATABASE_URL=postgresql://username:password@localhost:5432/agent_db
   PORT=5000
   ```
   Jalankan server backend:
   ```bash
   npm run dev
   ```

2. **Setup Frontend**
   ```bash
   cd ../frontend
   npm install
   npm run dev
   ```
   Akses frontend development server di [http://localhost:5173](http://localhost:5173).

---

## File Penting
- **Database Setup & Pool**: [db.js](file:///home/dimasanwaraziz/kodingan/agent/backend/src/db.js)
- **Local Embedding Helper**: [embeddings.js](file:///home/dimasanwaraziz/kodingan/agent/backend/src/embeddings.js)
- **LLM API & Memory Extraction**: [llm.js](file:///home/dimasanwaraziz/kodingan/agent/backend/src/llm.js)
- **Express App Routes**: [index.js](file:///home/dimasanwaraziz/kodingan/agent/backend/src/index.js)
- **Dashboard Interface**: [App.tsx](file:///home/dimasanwaraziz/kodingan/agent/frontend/src/App.tsx)
- **CSS Styling System**: [index.css](file:///home/dimasanwaraziz/kodingan/agent/frontend/src/index.css) & [App.css](file:///home/dimasanwaraziz/kodingan/agent/frontend/src/App.css)