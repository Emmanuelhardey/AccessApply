# AccessApply
# AccessApply

**A voice-first job application assistant for people with visual impairment.**
Built for the *Employment and Livelihoods* hackathon theme.

Searching for jobs and writing applications means reading dense web pages, filling in forms and formatting a CV, which is hard without sight. AccessApply lets a person do it by talking: say what job you want, hear matching jobs read aloud, answer a few questions, and get a ready CV and cover letter that is sent to the employer by email.

## What it does

1. **Voice in and out:** speech is turned into text by Whisper (via Groq); replies are spoken by the browser.
2. **Job search by voice:** "sales executive in Lagos" searches live Indeed Nigeria listings (JobSpy) and keeps only jobs that give an application email. If live search is unavailable it uses a saved list of sample jobs, so the demo never breaks.
3. **Voice interview:** asks for name, experience and skills.
4. **AI cover letter:** written by a Llama model from the job description and only the facts the user gave.
5. **CV as PDF:** generated automatically and attached.
6. **Email sending:** after a spoken "send", the application goes out by Gmail. In **demo mode (default)** every email goes to your own inbox, never to a real employer.

If a service is not configured, that step falls back safely: saved jobs, a template letter, or "prepared, not sent". The saved sample jobs use fictional `.example` addresses.

## Run it on your computer

You need **Python 3.9+** and a **free Groq API key** (no card needed): <https://console.groq.com/keys>

1. Download or clone this repository and open a terminal in the folder.
2. Copy `.env.example` to a new file called `.env` and fill it in. Only `GROQ_API_KEY` is required; add `SMTP_USER` and `SMTP_PASS` (a Gmail App Password) to enable real sending.
3. Start it:
   - **Windows:** double-click `start.bat`
   - **Mac / Linux:** run `./start.sh`
   - Or manually:
     ```
     python -m pip install -r requirements.txt
     python -m pip install -r requirements-live.txt   # optional: live job search
     python -m uvicorn server:app --port 8000
     ```
4. Open <http://localhost:8000> in **Chrome or Edge**, allow the microphone, and tap the big button once.

Try saying: *"Sales executive in Lagos"*, then *"apply"*, then answer the questions.

## How it works

```
Browser (static/index.html)              Server (server.py)
  records your voice  ───── audio ─────►  /transcribe ─► Groq Whisper
  shows the text      ◄──── text ──────   returns the words
  speaks replies with the browser's text-to-speech
  runs the conversation: search ► choose job ► CV + letter ► confirm
```

- `server.py`: a small FastAPI server. It serves the page and transcribes audio. Your API key stays on the server and is never sent to the browser.
- `static/index.html`: the whole interface and the conversation flow in one file.

## Project structure

```
server.py              FastAPI server: /transcribe, /jobs, /letter, /send
demo_cache.json        Saved sample jobs (fallback)
static/index.html      Page structure
static/style.css       Design (colours, layout, fonts)
static/app.js          Voice conversation and server calls
requirements.txt       Python packages
.env.example           Template for your API key (copy to .env)
start.bat / start.sh   One-step launchers
```

## Privacy and safety notes

- Your voice recording is sent to Groq to be transcribed and is not stored by this app.
- Nothing is sent without a spoken confirmation, and the cover letter is read aloud first. Keep `DEMO_MODE=true` unless you intend to email real employers.
- Live job data comes from scraping Indeed, which its terms do not allow; this is a prototype, and a production version should use licensed or partner job feeds.
- Never commit your `.env` file. It is already in `.gitignore`.

## Roadmap

1. Licensed job feeds (for example Jooble) and more Nigerian sources
2. Gmail sign-in (OAuth) instead of an App Password, so each user sends from their own account
3. Saved profile and application history by voice
4. Voice input in Nigerian languages

