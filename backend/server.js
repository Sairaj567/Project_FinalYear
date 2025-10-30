const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.RESUME_SERVER_PORT || 3001;

const GEMINI_API_KEY = typeof global.__gemini_api_key !== 'undefined'
  ? global.__gemini_api_key
  : process.env.GEMINI_API_KEY;

let geminiModel = null;
if (GEMINI_API_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const modelName = process.env.RESUME_MODEL || 'gemini-2.5-pro';
    geminiModel = genAI.getGenerativeModel({ model: modelName });
    console.log(`Gemini model initialised: ${modelName}`);
  } catch (error) {
    console.error('Failed to initialise Gemini client:', error.message);
  }
} else {
  console.warn('GEMINI_API_KEY is missing. AI-powered features will use mock fallbacks.');
}

app.use(cors({
  origin: process.env.RESUME_FRONTEND_ORIGIN || '*',
}));
app.use(express.json({ limit: '1mb' }));

const mockResume = {
  personalInfo: {
    name: 'Alex Johnson',
    email: 'alex.j@example.com',
    phone: '555-500-1234',
    linkedin: 'https://linkedin.com/in/alexj',
    github: 'https://github.com/alexj-dev',
    portfolio: 'https://alexj.dev',
  },
  education: [
    {
      college: 'State University',
      degree: 'M.S. Data Science',
      cgpa: '3.9',
      year: '2025',
      coursework: 'Machine Learning, Cloud Computing, Distributed Systems',
    },
  ],
  skills: ['Python', 'TensorFlow', 'React', 'AWS', 'Data Pipelines'],
  experience: [
    {
      company: 'Tech Innovators',
      role: 'Data Science Intern',
      duration: 'May 2024 - Aug 2024',
      description: [
        'Developed automated ETL jobs that reduced data preparation time by 30%.',
        'Experimented with transformer models to uplift recommendation CTR by 12%.',
      ],
    },
  ],
  projects: [
    {
      title: 'AI Resume Grader',
      technologies: 'React, Node, Gemini API',
      description: 'Built a full-stack tool that analyses resumes and suggests targeted improvements using Gemini.',
      githubLink: 'https://github.com/alexj-dev/ai-resume-grader',
    },
  ],
  achievements: "Dean's List (2023, 2024)",
  extracurriculars: 'Volunteer mentor at local coding bootcamp; organiser of Data Science Club hackathons.',
  targetRole: 'Machine Learning Engineer',
};

app.post('/api/resume/fetch-profile', (req, res) => {
  res.json(mockResume);
});

app.post('/api/resume/save-draft', (req, res) => {
  const resumeData = req.body || {};
  const name = resumeData.personalInfo?.name || 'Anonymous';
  console.log(`[Database] Draft saved for: ${name}`);
  res.json({ success: true, draftId: Date.now().toString(36) });
});

app.post('/api/resume/generate', async (req, res) => {
  const resumeData = req.body || {};

  if (!resumeData || typeof resumeData !== 'object') {
    return res.status(400).json({ message: 'Resume data must be provided.' });
  }

  let enhancedContent = '';

  if (geminiModel) {
    try {
      const prompt = buildGenerationPrompt(resumeData);
      const result = await geminiModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'text/plain', // Gemini 2.5 only supports plain/json/xml responses; HTML returned as text
          temperature: 0.4,
        },
      });
      enhancedContent = result.response.text();
    } catch (error) {
      console.error('Gemini generate error, falling back to template:', error.message);
    }
  }

  if (!enhancedContent || enhancedContent.trim().length === 0) {
    enhancedContent = buildResumeHtml(resumeData);
  }

  res.json({ enhancedContent });
});

app.post('/api/resume/grade', async (req, res) => {
  const resumeData = req.body?.rawData || req.body?.resumeData;
  const enhancedContent = req.body?.enhancedContent;

  if (!resumeData || typeof resumeData !== 'object') {
    return res.status(400).json({ message: 'resumeData is required for grading.' });
  }

  let gradingPayload = null;

  if (geminiModel) {
    try {
      const prompt = buildGradingPrompt(resumeData, enhancedContent);
      const result = await geminiModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
        },
      });

      const text = result.response.text();
      gradingPayload = transformGeminiGrade(JSON.parse(text));
    } catch (error) {
      console.error('Gemini grading error, falling back to heuristic scoring:', error.message);
    }
  }

  if (!gradingPayload) {
    gradingPayload = heuristicGrade(resumeData);
  }

  res.json(gradingPayload);
});

app.post('/api/resume/apply-suggestions', (req, res) => {
  const rawData = req.body?.rawData || req.body?.resumeData || {};
  res.json({ improvedData: rawData });
});

app.get('/api/resume/download/:id', (req, res) => {
  res.status(501).json({ message: 'PDF generation not implemented. Integrate Puppeteer or PDFKit.' });
});

app.get('/api/resume/history/:studentId', (req, res) => {
  res.json({ items: [] });
});

app.listen(PORT, () => {
  console.log(`\uD83D\uDE80 Resume backend running on http://localhost:${PORT}`);
  console.log(`Gemini API key status: ${GEMINI_API_KEY ? 'Loaded' : 'Missing (using fallback mode)'}`);
});

function buildGenerationPrompt(resumeData) {
  return `You are an expert technical resume writer. Using the following JSON resume data, craft a modern, ATS-friendly resume as clean HTML without <html> or <body> tags. Use a single-column layout with bold section headings and bullet lists. Focus on clarity, quantified achievements, and consistent tense.

Resume JSON:\n${JSON.stringify(resumeData, null, 2)}\n`;
}

function buildGradingPrompt(resumeData, enhancedContent) {
  return `You are acting as both an Applicant Tracking System (ATS) analyst and senior career coach. Given the raw resume JSON and the enhanced HTML version, return a JSON object with the following exact keys: overallScore (0-100), atsScore (0-100), contentScore (0-100), designScore (0-100), completenessScore (0-100), suggestions (array of { priority: High|Medium|Low, type: string, detail: string, example: string|null }). Provide actionable, concise suggestions.

Raw JSON:\n${JSON.stringify(resumeData, null, 2)}\n
Enhanced HTML:\n${enhancedContent || buildResumeHtml(resumeData)}\n`;
}

function transformGeminiGrade(result) {
  if (!result || typeof result !== 'object') return null;

  const suggestions = Array.isArray(result.suggestions)
    ? result.suggestions.map((item) => ({
        priority: item.priority || 'Medium',
        type: item.type || item.area || 'General',
        detail: item.detail || item.text || 'No suggestion provided.',
        example: item.example || null,
      }))
    : [];

  const atsScore = result.atsScore || result.categoryScores?.atsCompatibility || 0;
  const contentScore = result.contentScore || result.categoryScores?.contentQuality || 0;
  const designScore = result.designScore || result.categoryScores?.formattingDesign || 0;
  const completenessScore = result.completenessScore || result.categoryScores?.completeness || 0;

  return {
    overallScore: result.overallScore || Math.round((atsScore + contentScore + designScore + completenessScore) / 4),
    atsScore,
    contentScore,
    designScore,
    completenessScore,
    suggestions,
  };
}

function heuristicGrade(resumeData) {
  const sectionsPresent = [
    !!resumeData.personalInfo?.name,
    Array.isArray(resumeData.education) && resumeData.education.length > 0,
    Array.isArray(resumeData.experience) && resumeData.experience.length > 0,
    Array.isArray(resumeData.skills) && resumeData.skills.length > 0,
  ].filter(Boolean).length;

  const completenessScore = Math.min(100, sectionsPresent * 25);
  const atsScore = Math.min(100, (resumeData.skills?.length || 0) * 15 + 25);
  const contentScore = Math.min(100, (resumeData.experience?.[0]?.description?.length || 0) * 20 + 40);
  const designScore = 70;
  const overallScore = Math.round((completenessScore + atsScore + contentScore + designScore) / 4);

  return {
    overallScore,
    atsScore,
    contentScore,
    designScore,
    completenessScore,
    suggestions: [
      {
        priority: 'High',
        type: 'Content Quality',
        detail: 'Add quantified achievements to the experience section to highlight impact.',
        example: 'Increased API throughput by 35% by optimising caching layers.',
      },
      {
        priority: 'Medium',
        type: 'ATS Keywords',
        detail: 'Include 4-5 keywords from the job description in your skills and experience bullets.',
        example: null,
      },
    ],
  };
}

function buildResumeHtml(resumeData) {
  const personal = resumeData.personalInfo || {};
  const education = Array.isArray(resumeData.education) ? resumeData.education : [];
  const experience = Array.isArray(resumeData.experience) ? resumeData.experience : [];
  const projects = Array.isArray(resumeData.projects) ? resumeData.projects : [];
  const skills = Array.isArray(resumeData.skills) ? resumeData.skills : [];

  const section = (title, content) =>
    content ? `<section style="margin-bottom: 20px;"><h2 style="font-size:18px;margin-bottom:8px;border-bottom:2px solid #e5e7eb;padding-bottom:4px;">${title}</h2>${content}</section>` : '';

  const personalBlock = `
    <header style="text-align:center;margin-bottom:24px;">
      <h1 style="font-size:28px;margin-bottom:4px;">${personal.name || 'Full Name'}</h1>
      <p style="color:#4b5563;">${[personal.email, personal.phone].filter(Boolean).join(' | ')}</p>
      <p style="color:#4b5563;">${[personal.linkedin, personal.github, personal.portfolio].filter(Boolean).join(' | ')}</p>
    </header>
  `;

  const educationBlock = education
    .map((edu) => `
      <div style="margin-bottom:12px;">
        <h3 style="font-size:16px;font-weight:600;">${edu.college || ''}</h3>
        <p style="margin:4px 0;color:#1f2937;">${edu.degree || ''} • ${edu.year || ''}</p>
        <p style="margin:0;color:#4b5563;">CGPA: ${edu.cgpa || 'N/A'}</p>
        ${edu.coursework ? `<p style="margin:4px 0;color:#4b5563;">Coursework: ${edu.coursework}</p>` : ''}
      </div>
    `)
    .join('');

  const experienceBlock = experience
    .map((exp) => `
      <div style="margin-bottom:16px;">
        <h3 style="font-size:16px;font-weight:600;">${exp.role || ''} • ${exp.company || ''}</h3>
        <p style="margin:4px 0;color:#1f2937;">${exp.duration || ''}</p>
        <ul style="margin:8px 0 0 20px;color:#374151;">
          ${(Array.isArray(exp.description) ? exp.description : []).map((bullet) => `<li>${bullet}</li>`).join('')}
        </ul>
      </div>
    `)
    .join('');

  const projectsBlock = projects
    .map((proj) => `
      <div style="margin-bottom:12px;">
        <h3 style="font-size:16px;font-weight:600;">${proj.title || ''}</h3>
        <p style="margin:4px 0;color:#1f2937;">Tech: ${proj.technologies || ''}</p>
        <p style="margin:0;color:#374151;">${proj.description || ''}</p>
        ${proj.githubLink ? `<p style="margin-top:4px;"><a href="${proj.githubLink}" style="color:#2563eb;">GitHub</a></p>` : ''}
      </div>
    `)
    .join('');

  const achievementsBlock = resumeData.achievements
    ? `<p style="color:#374151;">${resumeData.achievements}</p>`
    : '';

  const extracurricularBlock = resumeData.extracurriculars
    ? `<p style="color:#374151;">${resumeData.extracurriculars}</p>`
    : '';

  const skillsBlock = skills.length
    ? `<ul style="display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none;">${skills
        .map((skill) => `<li style="background:#e0e7ff;color:#312e81;padding:6px 12px;border-radius:9999px;font-size:14px;">${skill}</li>`)
        .join('')}</ul>`
    : '';

  return `
    <article style="font-family:'Inter',sans-serif;max-width:800px;margin:0 auto;padding:32px;background:#ffffff;color:#111827;line-height:1.5;">
      ${personalBlock}
      ${section('Professional Summary', resumeData.targetRole ? `<p style=\"color:#374151;\">Target Role: ${resumeData.targetRole}</p>` : '')}
      ${section('Skills', skillsBlock)}
      ${section('Experience', experienceBlock)}
      ${section('Projects', projectsBlock)}
      ${section('Education', educationBlock)}
      ${section('Achievements & Certifications', achievementsBlock)}
      ${section('Extracurricular Activities', extracurricularBlock)}
    </article>
  `;
}
