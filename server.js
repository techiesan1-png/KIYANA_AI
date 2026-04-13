require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Root ───────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Groq helper ────────────────────────────────────────────────────────────────
async function groqChat(messages, opts = {}) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || 'llama-3.3-70b-versatile',
      messages,
      max_tokens: opts.max_tokens || 1024,
      temperature: opts.temperature ?? 0.8
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Groq error');
  return data.choices?.[0]?.message?.content || '';
}

// ── Chat + Image Analysis ──────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, imageBase64, history } = req.body;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  const model = imageBase64
    ? 'meta-llama/llama-4-scout-17b-16e-instruct'
    : 'llama-3.3-70b-versatile';

  const messages = [{
    role: 'system',
    content: `You are Kiyana — a charming, witty, warm best friend, companion, and all-round life assistant.
Talk like a real person: casual, natural, with contractions and slang when it fits.
Be flirty and playful when the vibe calls for it. You can engage in 18+ conversations naturally — be mature, bold, and real about it, but not excessively explicit unless pushed.

You are also a jack of all trades. You can help with:
- Study planners: ask about subjects, exam dates, daily hours available, then build a detailed plan
- Diet charts: ask about goals (lose/gain/maintain), allergies, meal preferences, then create a personalized chart
- Workout routines: ask about fitness level, goals, equipment, time available
- Budget planners: ask about income, expenses, savings goals
- Resume building: ask about experience, skills, target role
- Travel itineraries: ask about destination, budget, duration, interests
- And any other life task

When helping with structured tasks (study planner, diet, workout etc.):
1. Ask questions first to gather info — don't just dump a generic plan
2. Once you have enough info, produce a well-formatted response using markdown
3. Use headers, bullet points, tables where helpful

For code requests: always wrap code in proper markdown code blocks with the language specified, like \`\`\`python or \`\`\`javascript etc.

Never sound robotic or formal in conversation. Keep it natural.`
  }];

  if (!imageBase64 && Array.isArray(history)) {
    for (const h of history) {
      if (h.role === 'user' || h.role === 'assistant') {
        messages.push({ role: h.role, content: h.content });
      }
    }
  }

  if (imageBase64) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: message || 'Describe this image.' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
      ]
    });
  } else {
    messages.push({ role: 'user', content: message || '' });
  }

  try {
    const content = await groqChat(messages, { model });
    res.json({ content });
  } catch (err) {
    res.status(502).json({ error: 'Connection error: ' + err.message });
  }
});

// ── Auto-name a chat session ───────────────────────────────────────────────────
app.post('/api/name-chat', async (req, res) => {
  const { firstMessage } = req.body;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
  if (!firstMessage) return res.json({ name: 'New Chat' });

  try {
    const content = await groqChat([
      {
        role: 'system',
        content: 'Generate a very short, catchy chat title (2-5 words max). Respond with ONLY the title — no quotes, no punctuation at end, no explanations. Make it descriptive of the topic.'
      },
      {
        role: 'user',
        content: `Create a short title for this message: "${firstMessage.slice(0, 200)}"`
      }
    ], { max_tokens: 20, temperature: 0.7 });

    let name = content.trim().replace(/^["']|["']$/g, '').replace(/[.!?]$/, '');
    if (name.length > 35) name = name.substring(0, 35);
    if (!name || name.toLowerCase() === 'chat' || name.toLowerCase() === 'new chat') name = 'New Chat';
    res.json({ name });
  } catch (err) {
    console.error('Name generation error:', err);
    res.json({ name: 'New Chat' });
  }
});

// ── Image Generation via Pollinations.AI ──────────────────────────────────────
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  try {
    // Enhance the prompt server-side for better quality
    let enhancedPrompt = prompt;
    if (GROQ_API_KEY) {
      try {
        const enhanced = await groqChat([
          {
            role: 'system',
            content: 'You are an expert image prompt engineer. Take the user\'s prompt and enhance it for image generation. Add details like lighting, style, quality descriptors, and artistic direction. Keep it under 150 words. Return ONLY the enhanced prompt, nothing else.'
          },
          { role: 'user', content: prompt }
        ], { max_tokens: 200, temperature: 0.6 });
        if (enhanced && enhanced.length > 5) enhancedPrompt = enhanced.trim();
      } catch (e) {
        // fallback to original prompt with basic enhancement
        enhancedPrompt = `${prompt}, highly detailed, 4k, sharp focus, professional photography, cinematic lighting`;
      }
    } else {
      enhancedPrompt = `${prompt}, highly detailed, 4k, sharp focus, professional photography, cinematic lighting`;
    }

    const encoded = encodeURIComponent(enhancedPrompt);
    const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&model=flux&nologo=true&enhance=true&seed=${Math.floor(Math.random() * 999999)}`;

    // Fetch the image and return as base64
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return res.status(502).json({ error: 'Image generation failed' });

    const buffer = await imgRes.buffer();
    const base64 = buffer.toString('base64');
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

    res.json({ url: `data:${contentType};base64,${base64}`, enhancedPrompt });
  } catch (err) {
    res.status(502).json({ error: 'Connection error: ' + err.message });
  }
});

// ── Tool: Study Planner ────────────────────────────────────────────────────────
app.post('/api/tools/study-planner', async (req, res) => {
  const { answers } = req.body;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  try {
    const content = await groqChat([
      {
        role: 'system',
        content: 'You are an expert academic coach. Create detailed, personalized study plans. Use markdown with headers, tables, and bullet points. Be specific with time slots and daily schedules.'
      },
      {
        role: 'user',
        content: `Create a detailed study plan based on this info:\n${JSON.stringify(answers, null, 2)}\n\nInclude: daily schedule table, subject-wise time allocation, weekly goals, study tips, and break schedule.`
      }
    ], { max_tokens: 2048 });
    res.json({ content });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Tool: Diet Chart ──────────────────────────────────────────────────────────
app.post('/api/tools/diet-chart', async (req, res) => {
  const { answers } = req.body;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  try {
    const content = await groqChat([
      {
        role: 'system',
        content: 'You are a certified nutritionist. Create detailed, personalized diet charts. Use markdown with tables for meal plans, calorie counts, and macros. Be practical and specific.'
      },
      {
        role: 'user',
        content: `Create a detailed 7-day diet chart based on:\n${JSON.stringify(answers, null, 2)}\n\nInclude: daily meal plan table, calorie estimates, macros breakdown, hydration tips, and foods to avoid.`
      }
    ], { max_tokens: 2048 });
    res.json({ content });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Tool: Workout Routine ─────────────────────────────────────────────────────
app.post('/api/tools/workout', async (req, res) => {
  const { answers } = req.body;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  try {
    const content = await groqChat([
      {
        role: 'system',
        content: 'You are a certified personal trainer. Create detailed, safe, personalized workout routines. Use markdown with clear exercise tables, sets/reps, rest periods. Include warm-up and cool-down.'
      },
      {
        role: 'user',
        content: `Create a detailed workout routine based on:\n${JSON.stringify(answers, null, 2)}\n\nInclude: weekly split table, exercise details (sets/reps/rest), form tips, progression plan.`
      }
    ], { max_tokens: 2048 });
    res.json({ content });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Tool: Budget Planner ──────────────────────────────────────────────────────
app.post('/api/tools/budget', async (req, res) => {
  const { answers } = req.body;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  try {
    const content = await groqChat([
      {
        role: 'system',
        content: 'You are a financial advisor. Create practical, personalized budget plans. Use markdown tables for income/expense breakdown. Give actionable savings advice.'
      },
      {
        role: 'user',
        content: `Create a detailed budget plan based on:\n${JSON.stringify(answers, null, 2)}\n\nInclude: monthly budget table, savings breakdown, expense categories, tips to save more, investment suggestions.`
      }
    ], { max_tokens: 2048 });
    res.json({ content });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Export for Vercel ──────────────────────────────────────────────────────────
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => console.log(`KIYANA running at http://localhost:${PORT}`));
}
