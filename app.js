// =================================================================
//                      IMPORTS & BASIC SETUP
// =================================================================
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local');
const passportLocalMongoose = require('passport-local-mongoose');
const MongoStore = require('connect-mongo');
const axios = require('axios');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const multer = require('multer');
const methodOverride = require('method-override');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const flash = require('connect-flash');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const { validateEnv } = require('./config/env');

validateEnv();

const { uploadFileToDrive, deleteFileFromDrive } = require('./services/googleDrive');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;

if (Number.isNaN(port)) {
  throw new Error('Invalid PORT value.');
}

let genAI = null;
if (process.env.GEMINI_API_KEY) {
  try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  } catch (error) {
    console.error('Failed to initialise Google Generative AI client:', error.message);
  }
} else {
  console.warn('GEMINI_API_KEY is missing. AI-powered features will use fallback implementations.');
}

let server;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts, please try again later.'
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

const resumeModelName = process.env.RESUME_MODEL || 'gemini-2.5-pro';
let resumeModel = null;

if (genAI) {
  try {
    resumeModel = genAI.getGenerativeModel({ model: resumeModelName });
    console.log(`Gemini resume model initialised: ${resumeModelName}`);
  } catch (error) {
    console.error('Failed to initialise resume builder Gemini model:', error.message);
  }
} else {
  console.warn('Resume builder will operate using heuristic fallbacks (Gemini client unavailable).');
}

const mockResume = {
  personalInfo: {
    name: 'Alex Johnson',
    email: 'alex.j@example.com',
    phone: '555-500-1234',
    linkedin: 'https://linkedin.com/in/alexj',
    github: 'https://github.com/alexj-dev',
    portfolio: 'https://alexj.dev'
  },
  education: [
    {
      college: 'State University',
      degree: 'M.S. Data Science',
      cgpa: '3.9',
      year: '2025',
      coursework: 'Machine Learning, Cloud Computing, Distributed Systems'
    }
  ],
  skills: ['Python', 'TensorFlow', 'React', 'AWS', 'Data Pipelines'],
  experience: [
    {
      company: 'Tech Innovators',
      role: 'Data Science Intern',
      duration: 'May 2024 - Aug 2024',
      description: [
        'Developed automated ETL jobs that reduced data preparation time by 30%.',
        'Experimented with transformer models to uplift recommendation CTR by 12%.'
      ]
    }
  ],
  projects: [
    {
      title: 'AI Resume Grader',
      technologies: 'React, Node, Gemini API',
      description: 'Built a full-stack tool that analyses resumes and suggests targeted improvements using Gemini.',
      githubLink: 'https://github.com/alexj-dev/ai-resume-grader'
    }
  ],
  achievements: "Dean's List (2023, 2024)",
  extracurriculars: 'Volunteer mentor at local coding bootcamp; organiser of Data Science Club hackathons.',
  targetRole: 'Machine Learning Engineer'
};

const sanitizeRequest = (req, _res, next) => {
  ['body', 'params', 'headers', 'query'].forEach((key) => {
    if (req[key]) {
      mongoSanitize.sanitize(req[key]);
    }
  });
  next();
};

const resolveDriveFolderId = (overrideKey) => process.env[overrideKey] || process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

const formatDriveLink = (driveUploadResult) => driveUploadResult.webViewLink || driveUploadResult.webContentLink || driveUploadResult.downloadUrl;

// =================================================================
//                      DATABASE CONNECTION
// =================================================================
mongoose.set('strictQuery', true);

const connectToDatabase = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB connected successfully.');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
};

// =================================================================
//                        MONGOOSE SCHEMAS
// =================================================================
// --- This section MUST come before the Passport Configuration ---

// --- User Schema ---
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  role: {
    type: String,
    enum: ['student', 'admin'],
    required: true
  },
  studentProfile: { type: mongoose.Schema.Types.ObjectId, ref: 'StudentProfile' }
});
userSchema.plugin(passportLocalMongoose);
// *** User model is defined HERE ***
const User = mongoose.model('User', userSchema);

// --- Student Profile Schema ---
const studentProfileSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  // Section 1: Personal Information
  personal: {
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    middleName: { type: String, default: '' },
    age: { type: Number, default: null },
    dob: { type: Date, default: null },
    contactNumber: { type: String, default: '' },
    linkedIn: { type: String, default: '' },
    github: { type: String, default: '' },
    otherSocialMedia: { type: String, default: '' },
    hobbies: [{ type: String }]
  },
  // Section 2: Educational Background
  education: {
    tenthPercentage: { type: Number, default: null },
    twelfthPercentage: { type: Number, default: null },
    diplomaPercentage: { type: Number, default: null }
  },
  // Section 3: Current Course
  currentCourse: {
    degree: { type: String, default: '' },
    department: { type: String, default: '' },
    branch: { type: String, default: '' },
    graduationYear: { type: Number, default: null },
    isPursuing: { type: Boolean, default: true },
    aggregatePercentage: { type: Number, default: null }
  },
  // Section 4: Skills
  skills: {
    technical: [{ type: String }],
    soft: [{ type: String }]
  },
  // Section 5: Extracurricular
  extracurricular: [{ type: String }],
  // Section 6: Projects
  projects: [{
    title: { type: String },
    description: { type: String },
    url: { type: String }
  }],
  // Section 7: Work Experience
  workExperience: [{
    company: { type: String },
    role: { type: String },
    technologiesUsed: [{ type: String }],
    lorUrl: { type: String, default: '' },
    lorDriveFileId: { type: String, default: '' },
    duration: { type: String },
    description: { type: String }
  }],
  // Section 8: Referrals
  referrals: [{
    name: { type: String },
    designation: { type: String },
    contactNumber: { type: String },
    email: { type: String }
  }],
  // Section 9: Main Documents
  certificates: [{
    title: { type: String },
    fileUrl: { type: String },
    driveFileId: { type: String, default: '' }
  }],
  resumeUrl: { type: String, default: '' },
  resumeDriveFileId: { type: String, default: '' }
});
const StudentProfile = mongoose.model('StudentProfile', studentProfileSchema);

// --- Job Schema (Updated) ---
const jobSchema = new mongoose.Schema({
  company_name: { type: String, required: true },
  job_title: { type: String, required: true },
  recruiter_name: { type: String },
  recruiter_email: { type: String },
  location: { type: String },
  location_details: { type: String },
  compensation: { type: String },
  key_skills_mentioned: [{ type: String }],
  summary: { type: String },
  next_step: { type: String },
  link: { type: String },
  status: { type: String, default: 'new' },
  date: { type: Date, default: Date.now }
}, { timestamps: true });
const Job = mongoose.model('Job', jobSchema);

// --- NEW Email Schema ---
// (Your friend's n8n workflow will create documents in this collection)
const emailSchema = new mongoose.Schema({
  from: { type: String, required: true },
  subject: { type: String, required: true },
  body: { type: String, required: true },
  label: {
    type: String,
    enum: ['Competition', 'Internship', 'Job Opportunity', 'Reply', 'URGENT', 'Other'],
    default: 'Other'
  },
  receivedAt: { type: Date, default: Date.now },
  isRead: { type: Boolean, default: false }
});
const Email = mongoose.model('Email', emailSchema);

// =================================================================
//                        MIDDLEWARE SETUP
// =================================================================
if (isProduction) {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(morgan(isProduction ? 'combined' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(sanitizeRequest);
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: isProduction ? '1d' : 0
}));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads'), {
  maxAge: isProduction ? '1d' : 0
}));

const store = MongoStore.create({
  mongoUrl: process.env.MONGO_URI,
  touchAfter: 24 * 3600
});

store.on('error', (error) => {
  console.error('Session store error:', error);
});

app.use(session({
  store,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: isProduction,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

// 2. Flash (MUST be after session)
app.use(flash());

// =================================================================
//                 PASSPORT (AUTHENTICATION) CONFIG
// =================================================================
// --- This section MUST come AFTER the Mongoose Schemas ---

app.use(passport.initialize());
app.use(passport.session());

// *** User model is NOW defined and can be used here ***
passport.use(new LocalStrategy(User.authenticate()));
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

// --- Custom Middleware ---
app.use((req, res, next) => {
  res.locals.currentUser = req.user;
  // <-- 3. PASS FLASH TO ALL TEMPLATES -->
  // This is the line that was failing (app.js:202)
  // It will now work because app.use(flash()) is above it.
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.isProduction = isProduction;
  next();
});

const isLoggedIn = (req, res, next) => {
  if (!req.isAuthenticated()) {
    req.flash('error', 'You must be signed in first.'); // This will now work
    return res.redirect('/login');
  }
  next();
};

const isStudent = (req, res, next) => {
  if (req.user.role !== 'student') {
    req.flash('error', 'You do not have permission to view that page.');
    return res.redirect('/admin/dashboard');
  }
  next();
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    req.flash('error', 'You do not have permission to view that page.');
    return res.redirect('/student/profile');
  }
  next();
};

// =================================================================
//                        FILE UPLOAD (MULTER)
// =================================================================
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf' ||
      file.mimetype === 'application/msword' ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PDF and Word documents are allowed.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 1024 * 1024 * 5 }
});

const profileUpload = upload.fields([
  { name: 'resume', maxCount: 1 },
  { name: 'certificates', maxCount: 5 },
  { name: 'work_lor', maxCount: 1 }
]);

// =================================================================
//                        EMAIL (NODEMAILER)
// =================================================================
// Removed nodemailer configuration and sendWelcomeEmail function as they are no longer needed


// =================================================================
//                             ROUTES
// =================================================================

// --- General & Auth Routes ---
app.get('/', (req, res) => {
  res.render('index');
});

app.get('/login', (req, res) => {
  res.render('login', { error: req.flash('error') });
});

app.post('/login', authLimiter, passport.authenticate('local', {
  failureRedirect: '/login',
  failureFlash: 'Invalid username or password.'
}), (req, res) => {
  if (req.user.role === 'admin') {
    res.redirect('/admin/dashboard');
  } else {
    res.redirect('/student/profile');
  }
});

app.get('/register', (req, res) => {
  res.render('register');
});

app.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { username, email, password, role } = req.body;
    const user = new User({ username, email, role });
    const registeredUser = await User.register(user, password);

    if (role === 'student') {
      const newProfile = new StudentProfile({ user: registeredUser._id });
      await newProfile.save();
      registeredUser.studentProfile = newProfile._id;
      await registeredUser.save();
    }

    // Commented out the welcome email function call
    // sendWelcomeEmail(registeredUser.email, registeredUser.username).catch(console.error);

    req.login(registeredUser, (err) => {
      if (err) return next(err);
      if (role === 'admin') {
        res.redirect('/admin/dashboard');
      } else {
        res.redirect('/student/profile');
      }
    });

  } catch (e) {
    console.error(e);
    req.flash('error', 'Unable to register. Please try again.');
    res.redirect('/register');
  }
});

app.get('/logout', (req, res, next) => {
  req.logout(function(err) {
    if (err) { return next(err); }
    res.redirect('/');
  });
});


// --- Student Routes ---

app.get('/student/profile', isLoggedIn, isStudent, async (req, res) => {
  try {
    const profile = await StudentProfile.findOne({ user: req.user._id });
    res.render('student/profile', { profile });
  } catch (e) {
    console.error(e);
    res.redirect('/');
  }
});

app.post('/student/profile', isLoggedIn, isStudent, profileUpload, async (req, res) => {
  try {
    const profile = await StudentProfile.findOne({ user: req.user._id });
    const { body, files } = req;

    // Section 1: Personal
    profile.personal = {
      firstName: body.firstName,
      lastName: body.lastName,
      middleName: body.middleName,
      age: body.age,
      dob: body.dob,
      contactNumber: body.contactNumber,
      linkedIn: body.linkedIn,
      github: body.github,
      otherSocialMedia: body.otherSocialMedia,
      hobbies: body.hobbies ? body.hobbies.split(',').map(s => s.trim()) : []
    };
    // Section 2: Education
    profile.education = {
      tenthPercentage: body.tenthPercentage,
      twelfthPercentage: body.twelfthPercentage,
      diplomaPercentage: body.diplomaPercentage
    };
    // Section 3: Current Course
    profile.currentCourse = {
      degree: body.degree,
      department: body.department,
      branch: body.branch,
      graduationYear: body.graduationYear,
      isPursuing: body.isPursuing === 'true',
      aggregatePercentage: body.aggregatePercentage
    };
    // Section 4: Skills
    profile.skills = {
      technical: body.technicalSkills ? body.technicalSkills.split(',').map(s => s.trim()) : [],
      soft: body.softSkills ? body.softSkills.split(',').map(s => s.trim()) : []
    };
    // Section 5: Extracurricular
    profile.extracurricular = body.extracurricular ? body.extracurricular.split(',').map(s => s.trim()) : [];
    // Section 6: Projects
    // This form is designed to edit the first project entry.
    if (body.project_title) {
      if (profile.projects.length > 0) {
        // Update existing project
        profile.projects[0].title = body.project_title;
        profile.projects[0].description = body.project_description;
        profile.projects[0].url = body.project_url;
      } else {
        // Add new project if none exist
        profile.projects.push({
          title: body.project_title,
          description: body.project_description,
          url: body.project_url
        });
      }
    }
    const resumeFolderId = resolveDriveFolderId('GOOGLE_DRIVE_RESUME_FOLDER_ID');
    const certificateFolderId = resolveDriveFolderId('GOOGLE_DRIVE_CERTIFICATE_FOLDER_ID');
    const lorFolderId = resolveDriveFolderId('GOOGLE_DRIVE_LOR_FOLDER_ID');

    // Section 7: Work Experience
    let newLorLink = null;
    let newLorDriveFileId = null;
    if (files['work_lor'] && files['work_lor'][0]) {
      try {
        const lorFile = files['work_lor'][0];
        const lorUpload = await uploadFileToDrive({
          buffer: lorFile.buffer,
          mimeType: lorFile.mimetype,
          originalName: lorFile.originalname,
          folderId: lorFolderId
        });
        newLorLink = formatDriveLink(lorUpload);
        newLorDriveFileId = lorUpload.id;

        if (profile.workExperience.length > 0 && profile.workExperience[0].lorDriveFileId) {
          await deleteFileFromDrive(profile.workExperience[0].lorDriveFileId).catch((error) => {
            console.warn('Unable to delete previous LOR from Drive:', error.message);
          });
        }
      } catch (uploadError) {
        console.error('LOR upload error:', uploadError);
        req.flash('error', 'Failed to upload Letter of Recommendation to Drive. Please try again.');
        return res.redirect('/student/profile');
      }
    }
    // This form is designed to edit the first work experience entry.
    if (body.work_company) {
       if (profile.workExperience.length > 0) {
        // Update existing work experience
        profile.workExperience[0].company = body.work_company;
        profile.workExperience[0].role = body.work_role;
        profile.workExperience[0].technologiesUsed = body.work_technologies ? body.work_technologies.split(',').map(s => s.trim()) : [];
        profile.workExperience[0].duration = body.work_duration;
        profile.workExperience[0].description = body.work_description;
        if (newLorLink) {
          profile.workExperience[0].lorUrl = newLorLink;
          profile.workExperience[0].lorDriveFileId = newLorDriveFileId;
        }
      } else {
        // Add new work experience if none exist
        profile.workExperience.push({
          company: body.work_company,
          role: body.work_role,
          technologiesUsed: body.work_technologies ? body.work_technologies.split(',').map(s => s.trim()) : [],
          duration: body.work_duration,
          description: body.work_description,
          lorUrl: newLorLink || '',
          lorDriveFileId: newLorDriveFileId || ''
        });
      }
    }
    // Section 8: Referrals
    profile.referrals = [];
    if (body.ref1_name) {
      profile.referrals.push({
        name: body.ref1_name,
        designation: body.ref1_designation,
        contactNumber: body.ref1_contact,
        email: body.ref1_email
      });
    }
    if (body.ref2_name) {
      profile.referrals.push({
        name: body.ref2_name,
        designation: body.ref2_designation,
        contactNumber: body.ref2_contact,
        email: body.ref2_email
      });
    }
    // Section 9: Documents
    if (files['resume'] && files['resume'][0]) {
      try {
        const resumeFile = files['resume'][0];
        const previousResumeFileId = profile.resumeDriveFileId;
        const resumeUpload = await uploadFileToDrive({
          buffer: resumeFile.buffer,
          mimeType: resumeFile.mimetype,
          originalName: resumeFile.originalname,
          folderId: resumeFolderId
        });

        profile.resumeUrl = formatDriveLink(resumeUpload);
        profile.resumeDriveFileId = resumeUpload.id;

        if (previousResumeFileId) {
          await deleteFileFromDrive(previousResumeFileId).catch((error) => {
            console.warn('Unable to delete previous resume from Drive:', error.message);
          });
        }
      } catch (uploadError) {
        console.error('Resume upload error:', uploadError);
        req.flash('error', 'Failed to upload resume to Drive. Please try again.');
        return res.redirect('/student/profile');
      }
    }

    if (files['certificates'] && files['certificates'].length > 0) {
      try {
        const certificateUploads = await Promise.all(files['certificates'].map(async (file) => {
          const uploadedCertificate = await uploadFileToDrive({
            buffer: file.buffer,
            mimeType: file.mimetype,
            originalName: file.originalname,
            folderId: certificateFolderId
          });

          return {
            title: path.parse(file.originalname).name || 'Certificate',
            fileUrl: formatDriveLink(uploadedCertificate),
            driveFileId: uploadedCertificate.id
          };
        }));

        profile.certificates.push(...certificateUploads);
      } catch (uploadError) {
        console.error('Certificate upload error:', uploadError);
        req.flash('error', 'Failed to upload certificate(s) to Drive. Please try again.');
        return res.redirect('/student/profile');
      }
    }
    
    await profile.save();
    res.redirect('/student/profile');
  } catch (e) {
    console.error("Profile Update Error:", e);
    res.redirect('/student/profile');
  }
});

app.get('/student/profile/preview', isLoggedIn, isStudent, async (req, res) => {
  try {
    const profile = await StudentProfile.findOne({ user: req.user._id }).populate('user', 'email');
    res.render('student/profile-preview', { profile });
  } catch (e) {
    console.error(e);
    res.redirect('/student/profile');
  }
});

app.get('/student/jobs', isLoggedIn, isStudent, async (req, res) => {
  try {
    const { skill, location, company } = req.query;
    let filter = {};
    if (skill) filter.key_skills_mentioned = new RegExp(skill, 'i');
    if (location) filter.location = new RegExp(location, 'i');
    if (company) filter.company_name = new RegExp(company, 'i');

    const jobs = await Job.find(filter).sort({ date: -1 });
    res.render('student/jobs', { jobs, filters: req.query });
  } catch (e) {
    console.error(e);
    res.redirect('/student/profile');
  }
});

// ... in app.js
app.get('/student/jobs/:id', isLoggedIn, isStudent, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    const profile = await StudentProfile.findOne({ user: req.user._id });
    res.render('student/job-detail', {
      job,
      profile,
      n8nWebhookUrl: process.env.N8N_WEBHOOK_URL
    });
  } catch (e) {
    console.error(e);
    res.redirect('/student/jobs');
  }
});// app.post('/student/jobs/:id/apply', isLoggedIn, isStudent, applicationUpload, async (req, res) => {
//   try {
//     const job = await Job.findById(req.params.id);
//     const profile = await StudentProfile.findOne({ user: req.user._id });

//     let resumeUrl = profile.resumeUrl;
//     if (req.file) {
//       resumeUrl = `/uploads/applications/${req.file.filename}`;
//     }
//     if (!resumeUrl) {
//       return res.redirect(`/student/jobs/${req.params.id}`);
//     }

//     const newApplication = new Application({
//       job: job._id,
//       student: req.user._id,
//       appliedResumeUrl: resumeUrl,
//       profileSnapshot: {
//         fullName: `${profile.personal.firstName} ${profile.personal.lastName}`,
//         email: req.user.email,
//         branch: profile.currentCourse.branch,
//         cgpa: profile.currentCourse.aggregatePercentage
//       }
//     });
    
//     await newApplication.save();
//     res.redirect('/student/applications');
//   } catch (e) {
//     console.error(e);
//     res.redirect('/student/jobs');
//   }
// });
app.get('/student/resume-builder', isLoggedIn, isStudent, async (req, res) => {
  try {
    const profile = await StudentProfile.findOne({ user: req.user._id }).populate('user', 'email username');
    const resumeDraft = profile ? mapStudentProfileToResumeDraft(profile, profile.user || req.user) : null;
    const resumeHtml = resumeDraft ? buildResumeHtml(resumeDraft) : '';

    res.render('student/resume-builder', { profile, resumeDraft, resumeHtml });
  } catch (e) {
    console.error(e);
    res.redirect('/student/profile');
  }
});

// --- Resume Builder API Endpoints ---
app.post('/api/resume/fetch-profile', isLoggedIn, isStudent, async (req, res) => {
  try {
    const profile = await StudentProfile.findOne({ user: req.user._id }).populate('user', 'email username');
    if (!profile) {
      return res.json(mockResume);
    }

    const mappedProfile = mapStudentProfileToResumeDraft(profile, profile.user || req.user);
    res.json(mappedProfile || mockResume);
  } catch (error) {
    console.error('Resume fetch-profile error:', error);
    res.json(mockResume);
  }
});

app.post('/api/resume/save-draft', isLoggedIn, isStudent, apiLimiter, async (req, res) => {
  try {
    const resumeData = req.body || {};
    const draftId = Date.now().toString(36);
    console.log(`[ResumeDraft] user=${req.user.username} draftId=${draftId}`, {
      fields: Object.keys(resumeData)
    });
    res.json({ success: true, draftId });
  } catch (error) {
    console.error('Resume save-draft error:', error);
    res.status(500).json({ success: false, message: 'Unable to save draft right now.' });
  }
});

app.post('/api/resume/generate', isLoggedIn, isStudent, apiLimiter, async (req, res) => {
  const resumeData = req.body || {};

  if (!resumeData || typeof resumeData !== 'object') {
    return res.status(400).json({ message: 'Resume data must be provided.' });
  }

  let enhancedContent = '';

  if (resumeModel) {
    try {
      const prompt = buildGenerationPrompt(resumeData);
      const result = await resumeModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'text/plain',
          temperature: 0.4
        }
      });
      enhancedContent = result.response.text();
    } catch (error) {
      console.error('Gemini generate error, falling back to template:', error.message);
    }
  }

  if (!enhancedContent || !enhancedContent.trim()) {
    enhancedContent = buildResumeHtml(resumeData);
  }

  res.json({ enhancedContent });
});

app.post('/api/resume/grade', isLoggedIn, isStudent, apiLimiter, async (req, res) => {
  const resumeData = req.body?.rawData || req.body?.resumeData;
  const enhancedContent = req.body?.enhancedContent;

  if (!resumeData || typeof resumeData !== 'object') {
    return res.status(400).json({ message: 'resumeData is required for grading.' });
  }

  let gradingPayload = null;

  if (resumeModel) {
    try {
      const prompt = buildGradingPrompt(resumeData, enhancedContent);
      const result = await resumeModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2
        }
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

app.post('/api/resume/apply-suggestions', isLoggedIn, isStudent, apiLimiter, async (req, res) => {
  const rawData = req.body?.rawData || req.body?.resumeData || {};
  const suggestions = Array.isArray(req.body?.suggestions) ? req.body.suggestions : [];

  console.log('[Resume][ApplySuggestions] request received', {
    user: req.user?.username,
    suggestionCount: suggestions.length,
    hasTargetRole: !!rawData?.targetRole,
    skillCount: Array.isArray(rawData?.skills) ? rawData.skills.length : 0,
    experienceCount: Array.isArray(rawData?.experience) ? rawData.experience.length : 0
  });

  let improvedDraft = null;
  let actionPlan = [];

  if (resumeModel) {
    try {
      const prompt = buildApplySuggestionsPrompt(rawData, suggestions);
      const result = await resumeModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.3
        }
      });

      const rawText = result.response.text();
      const parsed = safeJsonParse(rawText);

      if (parsed && typeof parsed === 'object') {
        const candidateResume = parsed.updatedResume || parsed.resume || parsed.data || null;
        if (candidateResume && typeof candidateResume === 'object') {
          improvedDraft = candidateResume;
        }

        const candidatePlan = parsed.actionPlan || parsed.aiChecklist || parsed.revisionSteps || [];
        actionPlan = normaliseActionPlan(candidatePlan, suggestions);
        console.log('[Resume][ApplySuggestions] Gemini response parsed', {
          resumeKeys: candidateResume ? Object.keys(candidateResume) : [],
          actionPlanCount: actionPlan.length
        });
      }
    } catch (error) {
      console.error('Gemini apply-suggestions error, falling back to heuristic improvements:', error.message);
    }
  }

  if (!improvedDraft) {
    const heuristicResult = applySuggestionsHeuristically(rawData, suggestions);
    improvedDraft = heuristicResult.draft;
    actionPlan = normaliseActionPlan(heuristicResult.actionPlan, suggestions);
    console.log('[Resume][ApplySuggestions] Using heuristic improvements', {
      actionPlanCount: actionPlan.length
    });
  } else if (!actionPlan.length) {
    actionPlan = normaliseActionPlan([], suggestions);
  }

  console.log('[Resume][ApplySuggestions] response ready', {
    updatedSkills: Array.isArray(improvedDraft?.skills) ? improvedDraft.skills.length : 0,
    actionPlanCount: actionPlan.length
  });

  res.json({ improvedData: improvedDraft, actionPlan });
});

app.get('/api/resume/download/:id', isLoggedIn, isStudent, apiLimiter, (_req, res) => {
  res.status(501).json({ message: 'PDF generation not implemented. Integrate Puppeteer or PDFKit.' });
});

app.get('/api/resume/history/:studentId', isLoggedIn, isStudent, apiLimiter, (req, res) => {
  if (req.params.studentId !== String(req.user._id)) {
    return res.json({ items: [] });
  }

  res.json({ items: [] });
});

// --- Admin Routes ---

app.get('/admin/dashboard', isLoggedIn, isAdmin, async (req, res) => {
  try {
    // We can only get stats from our OWN database
    const [totalStudents, totalJobs] = await Promise.all([
      User.countDocuments({ role: 'student' }),
      Job.countDocuments()
    ]);

    // All other stats are now in Google Sheets
    const stats = {
      totalStudents,
      totalJobs,
      totalApplications: "N/A (See Google Sheets)",
      totalPlaced: "N/A (See Google Sheets)",
      averagePackage: "N/A",
      highestPackage: "N/A"
    };
    
    // We also can't show placed students or package data
    res.render('admin/dashboard', { 
      stats, 
      placedStudents: [], // Pass empty array
      packageData: "[]" // Pass empty array
    });

  } catch (e) {
    console.error(e);
    res.send("Error loading admin dashboard.");
  }
});

app.get('/admin/jobs', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const jobs = await Job.find({}).sort({ date: -1 });
    res.render('admin/manage-jobs', { jobs });
  } catch (e) {
    console.error(e);
    res.redirect('/admin/dashboard');
  }
});

app.get('/admin/jobs/:id/edit', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    res.render('admin/edit-job', { job });
  } catch (e) {
    console.error(e);
    res.redirect('/admin/jobs');
  }
});

// CORRECTED Edit Job PUT route
app.put('/admin/jobs/:id', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const { 
      job_title, company_name, location, location_details, compensation, 
      summary, link, next_step, key_skills_mentioned 
    } = req.body;
    await Job.findByIdAndUpdate(req.params.id, {
      job_title, company_name, location, location_details, compensation,
      summary, link, next_step,
      key_skills_mentioned: key_skills_mentioned ? key_skills_mentioned.split(',').map(s => s.trim()) : []
    });
    req.flash('success', 'Job updated successfully.');
    res.redirect('/admin/jobs');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Error updating job: ' + e.message);
    res.redirect(`/admin/jobs/${req.params.id}/edit`);
  }
});
app.delete('/admin/jobs/:id', isLoggedIn, isAdmin, async (req, res) => {
    try {
        const deletedJob = await Job.findByIdAndDelete(req.params.id);
        if (!deletedJob) {
             req.flash('error', 'Job not found.');
             return res.redirect('/admin/jobs');
        }
        // No need to delete Applications as they are external
        req.flash('success', 'Job deleted.');
        res.redirect('/admin/jobs');
    } catch (e) { console.error(e); req.flash('error', 'Error deleting job.'); res.redirect('/admin/jobs'); }
});


// === NEW MAILBOX ROUTE START ===
app.get('/admin/mailbox', isLoggedIn, isAdmin, async (req, res) => {
  try {
    let filter = {};
    const { label } = req.query;

    if (label && label !== 'All') {
      filter.label = label;
    }

    const emails = await Email.find(filter).sort({ receivedAt: -1 });
    const labels = ['All', 'Competition', 'Internship', 'Job Opportunity', 'Reply', 'URGENT', 'Other'];
    
    res.render('admin/mailbox', { 
      emails, 
      labels, 
      currentLabel: label || 'All' 
    });
  } catch (e) {
    console.error(e);
    req.flash('error', 'Error fetching mailbox: ' + e.message);
    res.redirect('/admin/dashboard');
  }
});
// === NEW MAILBOX ROUTE END ===


// === NEW STUDENT-CENTRIC ROUTES START ===

// 1. Show a list of all students
app.get('/admin/students', isLoggedIn, isAdmin, async (req, res) => {
  try {
    // Find all users with role 'student' and populate their profile details
    const students = await User.find({ role: 'student' }).populate('studentProfile');
    res.render('admin/manage-students', { students });
  } catch (e) {
    console.error(e);
    req.flash('error', 'Error fetching students: ' + e.message);
    res.redirect('/admin/dashboard');
  }
});

// 2. Show a single student's full profile and application history
// === CORRECTED /admin/students/:id ROUTE ===
app.get('/admin/students/:id', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const studentUser = await User.findById(req.params.id);
    if (!studentUser || studentUser.role !== 'student') {
      req.flash('error', 'Student not found.');
      return res.redirect('/admin/students');
    }
    const profile = await StudentProfile.findOne({ user: studentUser._id }).populate('user', 'email');
    if (!profile) {
      req.flash('error', 'Student profile data not found.');
      return res.redirect('/admin/students');
    }
    // Pass ONLY profile to the template
    res.render('admin/student-detail', { profile }); // Application history is external

  } catch (e) {
    console.error(e);
    req.flash('error', 'Error fetching student details: ' + e.message);
    res.redirect('/admin/students');
  }
});
// === END CORRECTION ===

// === NEW STUDENT-CENTRIC ROUTES END ===

// 3. Show a preview of the student's builder-resume
app.get('/admin/students/:id/resume-builder-preview', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const studentUser = await User.findById(req.params.id);
    if (!studentUser) {
      req.flash('error', 'Student not found.');
      return res.redirect('/admin/students');
    }
    const profile = await StudentProfile.findOne({ user: studentUser._id }).populate('user', 'email username');
    const resumeDraft = profile ? mapStudentProfileToResumeDraft(profile, profile.user || studentUser) : null;
    const resumeHtml = resumeDraft ? buildResumeHtml(resumeDraft) : '';
    
    // We re-use the same EJS file, the EJS will hide the controls
    res.render('student/resume-builder', { profile, resumeDraft, resumeHtml });

  } catch (e) {
    console.error(e);
    req.flash('error', 'Error fetching resume preview: ' + e.message);
    res.redirect('/admin/students/' + req.params.id);
  }
});

// --- API Routes (for client-side fetch) ---

app.post('/api/apply-for-job', isLoggedIn, isStudent, apiLimiter, async (req, res) => {
  try {
    const { jobId, stuId, stuName, stuMail, portfolio, resumeUrl } = req.body;
    const webhookUrl = process.env.N8N_WEBHOOK_URL;

    if (!jobId || !stuId || !stuName || !stuMail || !resumeUrl) {
      return res.status(400).json({ success: false, message: 'Missing required application fields.' });
    }

    // Forward the request to n8n from the server
    await axios.get(webhookUrl, {
      params: {
        job_id: jobId,
        stu_id: stuId,
        stu_name: stuName,
        stu_mail: stuMail,
        resume_url: resumeUrl,
        portfolio: portfolio || undefined
      },
      timeout: 10000
    });

    res.json({ success: true, message: 'Application submitted successfully!' });

  } catch (error) {
    console.error('Error proxying application to n8n:', error);
    res.status(502).json({ success: false, message: 'Failed to submit application to the external service.' });
  }
});

function mapStudentProfileToResumeDraft(profileDoc, userDoc = {}) {
  if (!profileDoc) {
    return null;
  }

  const profile = typeof profileDoc.toObject === 'function' ? profileDoc.toObject() : profileDoc;
  const user = userDoc && typeof userDoc.toObject === 'function' ? userDoc.toObject() : userDoc;

  const fullName = [profile.personal?.firstName, profile.personal?.middleName, profile.personal?.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();

  const personalInfo = {
    name: fullName || (user.username || '').trim(),
    email: user.email || '',
    phone: profile.personal?.contactNumber || '',
    linkedin: profile.personal?.linkedIn || '',
    github: profile.personal?.github || '',
    portfolio: profile.personal?.otherSocialMedia || ''
  };

  const educationEntries = [];
  if (profile.currentCourse && (profile.currentCourse.degree || profile.currentCourse.branch || profile.currentCourse.department)) {
    const degreeParts = [profile.currentCourse.degree, profile.currentCourse.branch].filter(Boolean);
    educationEntries.push({
      college: profile.currentCourse.department || profile.currentCourse.degree || '',
      degree: degreeParts.join(' - '),
      cgpa: profile.currentCourse.aggregatePercentage != null && profile.currentCourse.aggregatePercentage !== ''
        ? String(profile.currentCourse.aggregatePercentage)
        : '',
      year: profile.currentCourse.graduationYear ? String(profile.currentCourse.graduationYear) : '',
      coursework: summariseAcademicHighlights(profile)
    });
  }
  if (!educationEntries.length) {
    educationEntries.push({ college: '', degree: '', cgpa: '', year: '', coursework: '' });
  }

  const experienceEntries = toArraySafe(profile.workExperience).map((exp) => ({
    company: exp.company || '',
    role: exp.role || '',
    duration: exp.duration || '',
    description: toDescriptionArray(exp.description, exp.technologiesUsed)
  }));
  if (!experienceEntries.length) {
    experienceEntries.push({ company: '', role: '', duration: '', description: [''] });
  }

  const projectsEntries = toArraySafe(profile.projects).map((proj) => ({
    title: proj.title || '',
    technologies: proj.technologies || '',
    description: proj.description || '',
    githubLink: proj.url || ''
  }));
  if (!projectsEntries.length) {
    projectsEntries.push({ title: '', technologies: '', description: '', githubLink: '' });
  }

  const combinedSkills = [...new Set([...toArraySafe(profile.skills?.technical), ...toArraySafe(profile.skills?.soft)])].filter(Boolean);
  if (!combinedSkills.length) {
    combinedSkills.push('Teamwork');
  }

  const achievementsText = toArraySafe(profile.certificates).map((cert) => cert.title).filter(Boolean).join('; ');
  const extracurricularText = toArraySafe(profile.extracurricular).filter(Boolean).join('; ')
    || toArraySafe(profile.personal?.hobbies).filter(Boolean).join('; ');

  const defaultRole = profile.currentCourse?.branch
    ? `${profile.currentCourse.branch} ${profile.currentCourse.degree || 'Professional'}`.trim()
    : mockResume.targetRole;

  return {
    personalInfo,
    education: educationEntries,
    skills: combinedSkills,
    experience: experienceEntries,
    projects: projectsEntries,
    achievements: achievementsText || '',
    extracurriculars: extracurricularText || '',
    targetRole: defaultRole || mockResume.targetRole
  };
}

function toArraySafe(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null && item !== undefined);
  }
  return [value];
}

function toDescriptionArray(description, technologies) {
  const bullets = [];

  if (Array.isArray(technologies) && technologies.length) {
    const techLine = technologies.filter(Boolean).join(', ');
    if (techLine) {
      bullets.push(`Tech stack: ${techLine}`);
    }
  }

  if (Array.isArray(description)) {
    description
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => bullets.push(item));
  } else if (typeof description === 'string') {
    description
      .split(/\r?\n/)
      .map((line) => line.replace(/^[•\-\s]+/, '').trim())
      .filter(Boolean)
      .forEach((line) => bullets.push(line));
  }

  if (!bullets.length) {
    bullets.push('');
  }

  return bullets;
}

function summariseAcademicHighlights(profile) {
  const parts = [];

  if (profile.education?.tenthPercentage) {
    parts.push(`10th: ${profile.education.tenthPercentage}%`);
  }
  if (profile.education?.twelfthPercentage) {
    parts.push(`12th: ${profile.education.twelfthPercentage}%`);
  }
  if (profile.education?.diplomaPercentage) {
    parts.push(`Diploma: ${profile.education.diplomaPercentage}%`);
  }

  return parts.join(' | ');
}

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
  if (!result || typeof result !== 'object') {
    return null;
  }

  const suggestions = Array.isArray(result.suggestions)
    ? result.suggestions.map((item) => ({
        priority: item.priority || 'Medium',
        type: item.type || item.area || 'General',
        detail: item.detail || item.text || 'No suggestion provided.',
        example: item.example || null
      }))
    : [];

  const atsScore = result.atsScore || result.categoryScores?.atsCompatibility || 0;
  const contentScore = result.contentScore || result.categoryScores?.contentQuality || 0;
  const designScore = result.designScore || result.categoryScores?.formattingDesign || 0;
  const completenessScore = result.completenessScore || result.categoryScores?.completeness || 0;

  const overall = result.overallScore || Math.round((atsScore + contentScore + designScore + completenessScore) / 4);

  return {
    overallScore: overall,
    atsScore,
    contentScore,
    designScore,
    completenessScore,
    suggestions
  };
}

function heuristicGrade(resumeData) {
  const sectionsPresent = [
    !!resumeData.personalInfo?.name,
    Array.isArray(resumeData.education) && resumeData.education.length > 0,
    Array.isArray(resumeData.experience) && resumeData.experience.length > 0,
    Array.isArray(resumeData.skills) && resumeData.skills.length > 0
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
        example: 'Increased API throughput by 35% by optimising caching layers.'
      },
      {
        priority: 'Medium',
        type: 'ATS Keywords',
        detail: 'Include 4-5 keywords from the job description in your skills and experience bullets.',
        example: null
      }
    ]
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

function safeJsonParse(payload) {
  if (!payload || typeof payload !== 'string') {
    return null;
  }

  let text = payload.trim();
  if (!text) {
    return null;
  }

  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/g, '').trim();
  }

  try {
    return JSON.parse(text);
  } catch (primaryError) {
    try {
      const sanitised = text
        .replace(/```[a-zA-Z]*\s*/g, '')
        .replace(/```/g, '')
        .replace(/\u0000/g, '')
        .trim();
      return JSON.parse(sanitised);
    } catch (secondaryError) {
      console.error('Failed to parse JSON payload from Gemini:', secondaryError.message);
      return null;
    }
  }
}

function buildApplySuggestionsPrompt(resumeData, suggestions) {
  return `You are an expert technical resume editor. You will be given the current resume JSON data and a list of improvement suggestions. Incorporate the suggestions directly into the resume content (rewrite bullets, add keywords, update targetRole, etc.) while keeping the original schema: personalInfo, education[], skills[], experience[], projects[], achievements, extracurriculars, targetRole. Respond with STRICT JSON using this shape:\n\n{\n  "updatedResume": { ... },\n  "actionPlan": [\n    {"priority": "High|Medium|Low", "task": "", "example": "optional"}\n  ]\n}\n\nOnly include fields that exist in the original resume structure. Preserve arrays and strings. Be concise but specific in your edits.\n\nResume JSON:\n${JSON.stringify(resumeData || {}, null, 2)}\n\nSuggestions:\n${JSON.stringify(suggestions || [], null, 2)}\n`;
}

function applySuggestionsHeuristically(resumeData, suggestions = []) {
  const draft = normaliseResumeDraft(resumeData);
  const actionPlan = [];

  const registerAction = (priority, task, example) => {
    if (!task) {
      return;
    }
    actionPlan.push({
      priority: priority || 'Medium',
      task,
      example: example || null
    });
  };

  if (!Array.isArray(suggestions) || !suggestions.length) {
    registerAction('Medium', 'Review AI feedback manually and adjust each section of your resume.', null);
    return { draft, actionPlan };
  }

  suggestions.forEach((suggestion) => {
    if (!suggestion || typeof suggestion !== 'object') {
      return;
    }

    const detail = (suggestion.detail || suggestion.text || '').trim();
    const example = suggestion.example || null;
    const priority = suggestion.priority || 'Medium';
    const lowerDetail = detail.toLowerCase();

    if (lowerDetail.includes('keyword') || lowerDetail.includes('ats')) {
      const keywords = extractKeywordsFromSuggestion(suggestion);
      if (keywords.length) {
        draft.skills = Array.isArray(draft.skills) ? draft.skills : [];
        keywords.forEach((keyword) => uniquePush(draft.skills, keyword));
        registerAction(priority, `Blend these ATS keywords into experience and skills: ${keywords.join(', ')}`, example);
      } else if (detail) {
        registerAction(priority, detail, example);
      }
      return;
    }

    if (lowerDetail.includes('quant')) {
      const targetExperience = draft.experience[0];
      if (targetExperience) {
        targetExperience.description = Array.isArray(targetExperience.description) ? targetExperience.description : [];
        const sampleBullet = example || 'Quantify the outcome of your work (e.g., "Increased API throughput by 35% by optimising caching layers").';
        uniquePush(targetExperience.description, sampleBullet);
      }
      registerAction(priority, detail || 'Add quantified achievements to your experience section.', example);
      return;
    }

    if (lowerDetail.includes('summary') || lowerDetail.includes('profile')) {
      if (example) {
        draft.targetRole = example;
      } else if (detail && !draft.targetRole) {
        draft.targetRole = detail;
      }
      registerAction(priority, detail || 'Refine your professional summary to highlight impact in a single sentence.', example);
      return;
    }

    if (lowerDetail.includes('project') && example) {
      const targetProject = draft.projects[0];
      if (targetProject) {
        targetProject.description = [targetProject.description, example].filter(Boolean).join('\n');
      }
      registerAction(priority, detail || 'Enhance project descriptions with clearer outcomes.', example);
      return;
    }

    if (detail) {
      const targetExperience = draft.experience[0];
      if (targetExperience) {
        targetExperience.description = Array.isArray(targetExperience.description) ? targetExperience.description : [];
        uniquePush(targetExperience.description, example || `AI Suggestion: ${detail}`);
      }
      registerAction(priority, detail, example);
    }
  });

  if (!actionPlan.length) {
    registerAction('Medium', 'Review AI feedback and update the resume sections accordingly.', null);
  }

  return { draft, actionPlan };
}

function normaliseActionPlan(plan, fallbackSuggestions) {
  const result = [];

  if (Array.isArray(plan)) {
    plan.forEach((item) => {
      if (!item) {
        return;
      }
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed) {
          result.push({ priority: 'Medium', task: trimmed, example: null });
        }
        return;
      }

      if (typeof item === 'object') {
        const task = (item.task || item.detail || '').trim();
        if (task) {
          result.push({
            priority: item.priority || 'Medium',
            task,
            example: item.example || null
          });
        }
      }
    });
  }

  if (!result.length && Array.isArray(fallbackSuggestions)) {
    fallbackSuggestions.forEach((suggestion) => {
      if (!suggestion || typeof suggestion !== 'object') {
        return;
      }
      const detail = (suggestion.detail || suggestion.text || '').trim();
      if (!detail) {
        return;
      }
      result.push({
        priority: suggestion.priority || 'Medium',
        task: detail,
        example: suggestion.example || null
      });
    });
  }

  return result;
}

function normaliseResumeDraft(data) {
  const clone = data && typeof data === 'object' ? JSON.parse(JSON.stringify(data)) : {};

  clone.personalInfo = clone.personalInfo && typeof clone.personalInfo === 'object'
    ? clone.personalInfo
    : { name: '', email: '', phone: '', linkedin: '', github: '', portfolio: '' };

  clone.education = Array.isArray(clone.education) && clone.education.length
    ? clone.education.map((edu) => ({
        college: edu?.college || '',
        degree: edu?.degree || '',
        cgpa: edu?.cgpa || '',
        year: edu?.year || '',
        coursework: edu?.coursework || ''
      }))
    : [{ college: '', degree: '', cgpa: '', year: '', coursework: '' }];

  clone.skills = Array.isArray(clone.skills) ? clone.skills.filter(Boolean) : [];

  clone.experience = Array.isArray(clone.experience) && clone.experience.length
    ? clone.experience.map((exp) => ({
        company: exp?.company || '',
        role: exp?.role || '',
        duration: exp?.duration || '',
        description: Array.isArray(exp?.description) && exp.description.length ? exp.description.filter(Boolean) : ['']
      }))
    : [{ company: '', role: '', duration: '', description: [''] }];

  clone.projects = Array.isArray(clone.projects) && clone.projects.length
    ? clone.projects.map((proj) => ({
        title: proj?.title || '',
        technologies: proj?.technologies || '',
        description: proj?.description || '',
        githubLink: proj?.githubLink || proj?.github || ''
      }))
    : [{ title: '', technologies: '', description: '', githubLink: '' }];

  clone.achievements = clone.achievements || '';
  clone.extracurriculars = clone.extracurriculars || '';
  clone.targetRole = clone.targetRole || '';

  return clone;
}

function uniquePush(targetArray, value) {
  if (!Array.isArray(targetArray)) {
    return;
  }
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (!trimmed) {
    return;
  }
  if (!targetArray.some((item) => item === trimmed)) {
    targetArray.push(trimmed);
  }
}

function extractKeywordsFromSuggestion(suggestion) {
  const payload = [suggestion?.detail, suggestion?.example]
    .filter(Boolean)
    .join(' ')
    .replace(/[\[\]]/g, ' ');

  if (!payload) {
    return [];
  }

  const segments = payload
    .split(/[,;\n]| and /i)
    .map((segment) => segment.replace(/"|'/g, '').trim())
    .filter((segment) => segment && segment.length <= 40);

  const keywords = [];
  segments.forEach((segment) => {
    if (!segment) {
      return;
    }
    if (segment.match(/\d/)) {
      keywords.push(segment);
      return;
    }
    if (segment.split(' ').length <= 4) {
      keywords.push(segment);
    }
  });

  return [...new Set(keywords)].slice(0, 6);
}

// =================================================================
//                        ERROR HANDLING
// =================================================================
app.use((req, res) => {
  if (req.originalUrl.startsWith('/api')) {
    return res.status(404).json({ success: false, message: 'Resource not found.' });
  }

  if (typeof res.locals.currentUser === 'undefined') {
    res.locals.currentUser = req.user || null;
  }
  if (typeof res.locals.success === 'undefined') {
    res.locals.success = [];
  }
  if (typeof res.locals.error === 'undefined') {
    res.locals.error = [];
  }

  res.status(404);
  res.render('error', {
    status: 404,
    message: 'The page you are looking for does not exist.',
    stack: null
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const status = err.status || 500;
  const message = status === 500 ? 'An unexpected error occurred.' : err.message;

  console.error('Unhandled application error:', err);

  if (req.originalUrl.startsWith('/api')) {
    return res.status(status).json({ success: false, message });
  }

  if (typeof res.locals.currentUser === 'undefined') {
    res.locals.currentUser = req.user || null;
  }
  if (typeof res.locals.success === 'undefined') {
    res.locals.success = [];
  }
  if (typeof res.locals.error === 'undefined') {
    res.locals.error = [];
  }

  res.status(status);
  res.render('error', {
    status,
    message,
    stack: isProduction ? null : err.stack
  });
});

// =================================================================
//                        SERVER START
// =================================================================
const startServer = async () => {
  await connectToDatabase();
  server = app.listen(port, () => {
    console.log(`Server running on port ${port} in ${process.env.NODE_ENV || 'development'} mode.`);
  });
};

startServer();

const gracefulShutdown = async (exitCode = 0) => {
  console.log('Initiating graceful shutdown...');
  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.connection.close(false);
  } catch (shutdownError) {
    console.error('Error during shutdown:', shutdownError);
  } finally {
    process.exit(exitCode);
  }
};

process.on('SIGINT', () => gracefulShutdown(0));
process.on('SIGTERM', () => gracefulShutdown(0));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  gracefulShutdown(1);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  gracefulShutdown(1);
});
