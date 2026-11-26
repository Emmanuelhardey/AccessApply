/* AccessApply front end: the voice conversation, plus calls to server.py. */

/* ---------- small helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1).replace(/[.\s]*$/, '.');
const hint = t => { $('#hint').textContent = t; };
const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}).then(r => r.json());

const YES = /\b(apply|yes|yeah|yep|ok|okay|sure|send|confirm|this one)\b/i;
const STOP = /\b(stop|cancel|quit)\b/i;

/* ---------- state ---------- */
let waiting = null;       // resolves when the user's answer arrives
let listening = false;
let started = false;
let retries = 0;
let micStream = null;
let useBrowserSTT = false; // switches on automatically if the server has no Groq key
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

/* ---------- conversation log ---------- */
function log(who, text) {
  const p = document.createElement('p');
  p.className = who;
  const label = document.createElement('span');
  label.className = 'sr'; // read by screen readers, hidden visually
  label.textContent = who === 'bot' ? 'AccessApply says: ' : 'You said: ';
  p.append(label, text);
  $('#log').append(p);
  $('#log').scrollTop = 1e6;
}

/* ---------- speaking (browser text-to-speech) ---------- */
function speakChunk(text) {
  return new Promise(resolve => {
    let done = false, timer;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    // Safety timer: some browsers never report that speech has ended.
    timer = setTimeout(finish, Math.max(2500, text.split(/\s+/).length * 520 + 1500));
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95;
      u.onend = u.onerror = finish;
      speechSynthesis.speak(u);
    } catch (e) { finish(); }
  });
}

async function say(text) {
  log('bot', text);
  hint('Speaking. Please wait…');
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  // Speak sentence by sentence; long text can cut off in Chrome otherwise.
  for (const part of (text.match(/[^.?!]+[.?!]*/g) || [text])) {
    if (part.trim()) await speakChunk(part.trim());
  }
  await new Promise(r => setTimeout(r, 400));
}

/* ---------- listening ---------- */
function hear() {
  return new Promise(resolve => {
    waiting = resolve;
    retries = 0;
    hint('Getting the microphone ready…');
    listen();
  });
}

function give(text) { // called when an answer arrives, spoken or typed
  text = (text || '').trim();
  if (!text || !waiting) return;
  log('you', text);
  const resolve = waiting;
  waiting = null;
  resolve(text);
}

function listen() {
  if (!waiting || listening) return;
  return useBrowserSTT ? listenBrowser() : listenWhisper();
}

/* Option 1 (best): record audio, send it to the server, Whisper returns the text. */
async function listenWhisper() {
  listening = true;
  try {
    micStream = micStream || await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    listening = false;
    hint('Microphone blocked or missing (' + e.name + '). Allow it, or type your answer below.');
    return;
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(micStream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const chunks = [];
  const recorder = new MediaRecorder(micStream);
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

  let heard = false, quietMs = 0;
  const startedAt = Date.now();
  $('#mic').classList.add('on');
  hint('Microphone is on. Speak now.');
  recorder.start();

  // Every 100 ms: measure loudness. Stop after 1.4 s of quiet once you have spoken.
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += Math.abs(v - 128);
    if (sum / samples.length > 6) { heard = true; quietMs = 0; hint('I can hear you…'); }
    else if (heard) quietMs += 100;
    if ((heard && quietMs > 1400) || Date.now() - startedAt > (heard ? 20000 : 9000)) recorder.stop();
  }, 100);

  recorder.onstop = async () => {
    clearInterval(timer);
    ctx.close();
    $('#mic').classList.remove('on');
    listening = false;
    if (!heard) {
      if (retries++ < 2) { setTimeout(listen, 300); return; }
      hint('I did not hear anything. Tap the button and speak, or type your answer.');
      return;
    }
    hint('Working out what you said…');
    const form = new FormData();
    form.append('audio', new Blob(chunks, { type: recorder.mimeType }),
                'speech.' + (recorder.mimeType.includes('mp4') ? 'm4a' : 'webm'));
    try {
      const data = await (await fetch('/transcribe', { method: 'POST', body: form })).json();
      if (data.text) { give(data.text); return; }
      if (data.error && data.error.includes('GROQ_API_KEY') && SR) {
        useBrowserSTT = true; // no key on the server: fall back to the browser's own recognition
        hint('No Groq key is set, so I am using your browser’s built-in speech recognition.');
        listen();
        return;
      }
      hint(data.error || 'I could not understand that. Tap the button to try again.');
    } catch (e) {
      hint('Could not reach the server. Is it running? You can type your answer below.');
    }
  };
}

/* Option 2 (fallback, no key needed): the browser's built-in speech recognition. */
function listenBrowser() {
  if (!SR) { hint('Voice input is not supported in this browser. Type your answer below.'); return; }
  listening = true;
  const rec = new SR();
  rec.lang = 'en-NG';
  rec.onstart = () => { $('#mic').classList.add('on'); hint('Microphone is on. Speak now.'); };
  rec.onresult = e => give(e.results[0][0].transcript);
  rec.onerror = e => hint(e.error === 'not-allowed'
    ? 'Microphone blocked. Allow it, or type your answer below.'
    : 'I could not hear that. Tap the button to try again, or type your answer.');
  rec.onend = () => { listening = false; $('#mic').classList.remove('on'); };
  try { rec.start(); } catch (e) { listening = false; }
}

/* ---------- calls to the server ---------- */
async function findJobs(query) {
  try {
    const data = await (await fetch('/jobs?q=' + encodeURIComponent(query))).json();
    return (data.jobs || []).map(j => ({
      title: j.title, company: j.company, loc: j.location, desc: j.description, full: j.full, email: j.email
    }));
  } catch (e) { return []; }
}

async function getLetter(job, name, experience, skills) {
  try {
    const data = await post('/letter', { job, name, experience, skills });
    if (data.letter) return data.letter;
  } catch (e) { /* use the template below */ }
  return `Dear Hiring Manager,\n\nI am writing to apply for the ${job.title} position at ${job.company}. ${cap(experience)} My key skills include ${skills}.\n\nI would welcome the chance to discuss how I can contribute to your team. Thank you for your consideration.\n\nYours sincerely,\n${name}`;
}

async function sendApplication(job, name, experience, skills, letter) {
  try {
    const data = await post('/send', {
      to: job.email, subject: `Application for ${job.title}, ${name}`, letter, name, experience, skills
    });
    if (data.status === 'sent') {
      return { ...data, say: `Done. Your application to ${job.company} was sent${data.demo ? ' in demo mode, to your own inbox' : ''}, with your CV attached.` };
    }
    if (data.status === 'not_configured') {
      return { ...data, say: 'Email sending is not set up on this computer, so I prepared your application but did not send it.' };
    }
  } catch (e) { /* fall through */ }
  return { status: 'error', say: 'I could not send the email. Please try again.' };
}

/* ---------- what appears on screen ---------- */
const stage = html => { $('#stage').innerHTML = html; };

function showJob(j, i, n) {
  stage(`<div class="card"><h3>${esc(j.title)}</h3><p>${esc(j.company)}, ${esc(j.loc)}</p><p>${esc(j.desc)}</p><p><span class="k">Apply by email:</span> ${esc(j.email)}</p><p>Job ${i} of ${n}</p></div>`);
}

function showReady(name, experience, skills, letter) {
  stage(`<div class="card"><h3>Your CV</h3><p class="k">${esc(name)}</p><p><span class="k">Experience:</span> ${esc(cap(experience))}</p><p><span class="k">Skills:</span> ${esc(skills)}</p></div><div class="card"><h3>Cover letter</h3><p class="letter">${esc(letter)}</p></div>`);
}

function showSent(j, name, letter, result) {
  const status = result.status === 'sent'
    ? (result.demo ? 'Sent in demo mode to your own inbox' : 'Sent to the employer')
    : 'Prepared, not sent';
  stage(`<div class="card"><h3>Application email</h3><p><span class="k">To:</span> ${esc(j.email)}</p><p><span class="k">Subject:</span> Application for ${esc(j.title)}, ${esc(name)}</p><p><span class="k">Attachment:</span> ${esc(name.replace(/\s+/g, '_'))}_CV.pdf</p><p class="letter">${esc(letter)}</p><span class="status">${status}</span></div>`);
}

function finish() { started = false; hint('Tap the button to start again.'); }

/* ---------- the conversation ---------- */
async function run() {
  try {
    await say('Welcome to AccessApply. I will help you find a job and apply by email. What kind of job are you looking for, and where?');
    const query = await hear();
    await say('Searching for jobs. One moment.');
    const jobs = await findJobs(query);
    if (!jobs.length) { await say('Sorry, I could not find any jobs. Tap the button to try again.'); return finish(); }
    await say(`I found ${jobs.length} job${jobs.length > 1 ? 's' : ''} you can apply to by email.`);

    // Read the jobs one at a time.
    let pick = null;
    for (let i = 0; i < jobs.length && !pick; i++) {
      const j = jobs[i];
      showJob(j, i + 1, jobs.length);
      await say(`Job ${i + 1}. ${j.title} at ${j.company}, in ${j.loc}. ${j.desc} Say apply to apply, or next to hear another.`);
      const answer = await hear();
      if (STOP.test(answer)) { await say('Okay, I have stopped. Tap the button to search again.'); return finish(); }
      if (YES.test(answer)) pick = j;
    }
    if (!pick) { await say('That was the last job. Tap the button to search again.'); return finish(); }

    // Collect the user's details.
    await say('Good choice. I will prepare your application. What is your full name?');
    const name = (await hear()).replace(/\b\w/g, c => c.toUpperCase());
    await say('Thank you. In one or two sentences, tell me about your work experience.');
    const experience = await hear();
    await say('Last question. What are your top skills?');
    const skills = (await hear()).replace(/[.\s]*$/, '');

    // Write the letter, read it back, ask for confirmation.
    await say('One moment while I write your cover letter.');
    const letter = await getLetter(pick, name, experience, skills);
    showReady(name, experience, skills, letter);
    await say('Your CV and cover letter are ready. Here is your cover letter. ' + letter.replace(/\n+/g, ' ') + ' Say send to apply, or cancel.');
    const answer = await hear();
    if (YES.test(answer) && !/\b(cancel|no)\b/i.test(answer)) {
      const result = await sendApplication(pick, name, experience, skills, letter);
      showSent(pick, name, letter, result);
      await say(result.say);
    } else {
      await say('Okay, I did not send it. Tap the button to start again.');
    }
  } catch (e) {
    await say('Something went wrong. Tap the button to start again.');
  }
  finish();
}

/* ---------- buttons ---------- */
$('#mic').onclick = () => {
  if (!started) { started = true; $('#mic').textContent = 'Listening'; run(); }
  else listen();
};
$('#tf').onsubmit = e => { e.preventDefault(); give($('#ti').value); $('#ti').value = ''; };
$('#reset').onclick = () => location.reload();
$('#mic').focus();
