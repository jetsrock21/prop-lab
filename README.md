# Prop Lab NBA

NBA prop betting analyzer with Monte Carlo simulation, game log engine, and DvP matchup data.

---

## Folder Structure

```
prop-lab/
├── index.html
├── package.json
├── vite.config.js
├── .gitignore
├── prop_lab_api.py       ← FastAPI backend (deploy to Railway)
├── requirements.txt      ← Python dependencies
├── Procfile              ← Railway start command
├── runtime.txt           ← Python version for Railway
└── src/
    ├── main.jsx          ← React entry point
    └── App.jsx           ← Main app (set VITE_API_BASE env var)
```

---

## Deploy Backend → Railway

1. Push this entire folder to a **GitHub repo**
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
3. Select your repo
4. Railway auto-detects Python via `requirements.txt`
5. Set these in Railway **Settings → Variables**:
   ```
   PORT=8000
   ```
   (Railway sets PORT automatically but add it if needed)
6. Under **Settings → Deploy**, confirm start command is:
   ```
   uvicorn prop_lab_api:app --host 0.0.0.0 --port $PORT
   ```
7. Click **Deploy** — Railway gives you a URL like:
   ```
   https://prop-lab-api-production.up.railway.app
   ```
   **Copy this URL — you need it for Vercel.**

---

## Deploy Frontend → Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import the **same GitHub repo**
3. Vercel detects Vite automatically. Confirm settings:
   - **Framework:** Vite
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
   - **Root Directory:** `/` (leave blank / default)
4. Add **Environment Variable** in Vercel settings:
   ```
   VITE_API_BASE = https://your-railway-url.up.railway.app
   ```
   Replace with your actual Railway URL from Step 7 above.
5. Click **Deploy**

Your app will be live at:
```
https://prop-lab.vercel.app
```

---

## Run Locally

**Backend (terminal 1):**
```bash
pip install -r requirements.txt
uvicorn prop_lab_api:app --reload --port 8000
```

**Frontend (terminal 2):**
```bash
npm install
npm run dev
# → http://localhost:5173
```

The frontend defaults to `http://localhost:8000` for the API when `VITE_API_BASE` is not set.

---

## Features

- Monte Carlo simulation (1k–50k iterations)
- Game log paste parser (auto-detects stat table format)
- Recency weighting with exponential decay
- DvP matchup auto-fill from Google Sheets
- NBA API player search + game log auto-load
- Boom/Bust/Ceiling Score
- History with full session restore
