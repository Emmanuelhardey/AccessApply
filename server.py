import asyncio
import json
import os
import re
import smtplib
from email.message import EmailMessage
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fpdf import FPDF
from pydantic import BaseModel

load_dotenv()
app = FastAPI()
GROQ = "https://api.groq.com/openai/v1"
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
CACHE = json.loads((Path(__file__).parent / "demo_cache.json").read_text(encoding="utf-8"))


# ---------- speech to text ----------
@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        return JSONResponse({"error": "The server has no GROQ_API_KEY set."}, status_code=500)
    data = await audio.read()
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(
                f"{GROQ}/audio/transcriptions",
                headers={"Authorization": f"Bearer {key}"},
                files={"file": (audio.filename or "speech.webm", data, audio.content_type or "audio/webm")},
                data={"model": "whisper-large-v3-turbo", "language": "en", "temperature": "0",
                      "prompt": "Nigerian English. Job search in Lagos, Abuja, Ibadan, Port Harcourt."},
            )
    except httpx.HTTPError:
        return JSONResponse({"error": "Could not reach the speech service."}, status_code=502)
    if r.status_code != 200:
        return JSONResponse({"error": f"Speech service error ({r.status_code})."}, status_code=502)
    return {"text": r.json().get("text", "").strip()}


# ---------- job search: live (JobSpy / Indeed Nigeria), else saved cache ----------
def short(text, n=170):
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= n:
        return text
    cut = text[:n]
    return (cut[: cut.rfind(" ")] if " " in cut else cut) + "."


def live_search(role, place):
    from jobspy import scrape_jobs  # optional dependency

    df = scrape_jobs(site_name=["indeed"], search_term=role, location=place or "Nigeria",
                     results_wanted=25, country_indeed="Nigeria")
    jobs = []
    for _, row in df.iterrows():
        full = str(row.get("description") or "")
        found = EMAIL_RE.findall(full) or EMAIL_RE.findall(str(row.get("emails") or ""))
        if not found:
            continue
        jobs.append({"title": str(row.get("title")), "company": str(row.get("company")),
                     "location": str(row.get("location")), "description": short(full),
                     "full": full[:2500], "email": found[0]})
    return jobs


def cache_search(q):
    words = [w for w in re.findall(r"[a-z]+", q.lower()) if len(w) > 2]
    scored = [(sum(w in (j["title"] + j["location"] + j["description"]).lower() for w in words), j) for j in CACHE]
    hits = [j for s, j in sorted(scored, key=lambda t: -t[0]) if s > 0]
    return hits or CACHE[:3]


@app.get("/jobs")
async def jobs(q: str):
    m = re.match(r"(.*?)\bin\b(.*)", q, re.I)
    role, place = (m.group(1).strip(), m.group(2).strip()) if m else (q.strip(), "")
    try:
        found = await asyncio.to_thread(live_search, role or q, place)
        if found:
            return {"source": "live", "jobs": found[:3]}
    except Exception:
        pass
    return {"source": "saved", "jobs": cache_search(q)[:3]}


# ---------- cover letter (Groq Llama) ----------
class LetterIn(BaseModel):
    job: dict
    name: str
    experience: str
    skills: str


@app.post("/letter")
async def letter(d: LetterIn):
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        return {"letter": None}
    prompt = (f"Write a professional cover letter of about 150 words for the job below. Use ONLY the facts "
              f"given about the candidate; do not invent employers, degrees or numbers. Start with 'Dear Hiring "
              f"Manager,' and end with 'Yours sincerely,' and the name. Plain text only.\n\n"
              f"Job: {d.job.get('title')} at {d.job.get('company')}\n"
              f"Job description: {(d.job.get('full') or d.job.get('desc') or '')[:1500]}\n\n"
              f"Candidate: {d.name}\nExperience: {d.experience}\nSkills: {d.skills}")
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{GROQ}/chat/completions", headers={"Authorization": f"Bearer {key}"},
                             json={"model": os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"),
                                   "temperature": 0.4, "messages": [{"role": "user", "content": prompt}]})
        return {"letter": r.json()["choices"][0]["message"]["content"].strip()}
    except Exception:
        return {"letter": None}


# ---------- CV (PDF) and email ----------
def make_pdf(name, experience, skills, letter):
    clean = lambda s: str(s).encode("latin-1", "replace").decode("latin-1")
    pdf = FPDF()
    pdf.set_auto_page_break(True, 15)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 20)
    pdf.cell(0, 12, clean(name), new_x="LMARGIN", new_y="NEXT")
    for title, body in (("Experience", experience), ("Skills", skills)):
        pdf.set_font("Helvetica", "B", 14)
        pdf.cell(0, 10, title, new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 12)
        pdf.multi_cell(0, 7, clean(body), new_x="LMARGIN", new_y="NEXT")
    pdf.add_page()
    pdf.set_font("Helvetica", "", 12)
    pdf.multi_cell(0, 7, clean(letter))
    return bytes(pdf.output())


class SendIn(BaseModel):
    to: str
    subject: str
    letter: str
    name: str
    experience: str
    skills: str


def smtp_send(d, to, user, pw):
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = user, to, d.subject
    msg.set_content(d.letter)
    msg.add_attachment(make_pdf(d.name, d.experience, d.skills, d.letter), maintype="application",
                       subtype="pdf", filename=f"{d.name.replace(' ', '_')}_CV.pdf")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
        s.login(user, pw)
        s.send_message(msg)


@app.post("/send")
async def send(d: SendIn):
    user, pw = os.environ.get("SMTP_USER"), os.environ.get("SMTP_PASS")
    if not (user and pw):
        return {"status": "not_configured"}
    demo = os.environ.get("DEMO_MODE", "true").lower() != "false"
    to = user if demo else d.to  # demo mode: always send to your own inbox
    try:
        await asyncio.to_thread(smtp_send, d, to, user, pw)
    except Exception:
        return {"status": "error"}
    return {"status": "sent", "demo": demo, "to": to}


app.mount("/", StaticFiles(directory="static", html=True), name="static")
