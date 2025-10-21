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
const path = require('path');
const multer = require('multer');
const nodemailer = require('nodemailer');
const methodOverride = require('method-override');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const flash = require('connect-flash'); // === 1. NEW IMPORT ===

const app = express();
const port = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// =================================================================
//                      DATABASE CONNECTION
// =================================================================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected successfully.'))
  .catch(err => console.error('MongoDB connection error:', err));

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
    graduationYear: { type: Number, default: 2025 },
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
    fileUrl: { type: String }
  }],
  resumeUrl: { type: String, default: '' }
});
const StudentProfile = mongoose.model('StudentProfile', studentProfileSchema);

// --- Job Schema ---
const jobSchema = new mongoose.Schema({
  title: { type: String, required: true },
  company: { type: String, required: true },
  location: { type: String, default: 'Remote' },
  ctc: { type: String, default: 'Not Disclosed' },
  description: { type: String, required: true },
  roleType: {
    type: String,
    enum: ['Campus Drive', 'Internship', 'Full-time', 'Part-time'],
    default: 'Full-time'
  },
  postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
const Job = mongoose.model('Job', jobSchema);

// --- Application Schema ---
const applicationSchema = new mongoose.Schema({
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['Applied', 'Pending', 'Selected', 'Rejected'],
    default: 'Applied'
  },
  appliedResumeUrl: { type: String, required: true },
  profileSnapshot: {
    fullName: String,
    email: String,
    branch: String,
    cgpa: Number
  }
}, { timestamps: true });
const Application = mongoose.model('Application', applicationSchema);


// =================================================================
//                        MIDDLEWARE SETUP
// =================================================================
app.set('view engine', 'ejs');
app.set('views', 'views');
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride('_method'));

const store = MongoStore.create({
  mongoUrl: process.env.MONGO_URI,
  secret: process.env.SESSION_SECRET,
  touchAfter: 24 * 3600
});

app.use(session({
  store: store,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    expires: Date.now() + 1000 * 60 * 60 * 24 * 7,
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
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let uploadPath = 'public/uploads/';
    if (file.fieldname === 'resume') {
      uploadPath += 'resumes/';
    } else if (file.fieldname === 'certificates') {
      uploadPath += 'certificates/';
    } else if (file.fieldname === 'applicationResume') {
      uploadPath += 'applications/';
    } else if (file.fieldname === 'work_lor') {
      uploadPath += 'lors/';
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

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
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 1024 * 1024 * 5 }
});

const profileUpload = upload.fields([
  { name: 'resume', maxCount: 1 },
  { name: 'certificates', maxCount: 5 },
  { name: 'work_lor', maxCount: 1 }
]);
const applicationUpload = upload.single('applicationResume');

// =================================================================
//                        EMAIL (NODEMAILER)
// =================================================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendWelcomeEmail(toEmail, username) {
  try {
    let info = await transporter.sendMail({
      from: `"Placement Portal" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: "Welcome to the Placement Portal! 🎉",
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h2>Hello, ${username}!</h2>
          <p>Thank you for registering at the Placement Portal. We are excited to have you on board.</p>
          <p>You can now log in to your account, complete your profile, and start applying for jobs.</p>
          <br>
          <p>Best of luck with your career!</p>
          <p><b>The Placement Portal Team</b></p>
        </div>
      `,
    });
    console.log("Welcome email sent: %s", info.messageId);
  } catch (error) {
    console.error("Error sending welcome email:", error);
  }
}

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

app.post('/login', passport.authenticate('local', {
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

app.post('/register', async (req, res, next) => {
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
    
    // Don't await this, let it send in the background
    sendWelcomeEmail(registeredUser.email, registeredUser.username).catch(console.error);

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
    if (body.project_title) {
      profile.projects = [{
        title: body.project_title,
        description: body.project_description,
        url: body.project_url
      }];
    }
    // Section 7: Work Experience
    let lorUrl = '';
    if (files['work_lor']) {
      lorUrl = `/uploads/lors/${files['work_lor'][0].filename}`;
    }
    if (body.work_company) {
      profile.workExperience = [{
        company: body.work_company,
        role: body.work_role,
        technologiesUsed: body.work_technologies ? body.work_technologies.split(',').map(s => s.trim()) : [],
        duration: body.work_duration,
        description: body.work_description,
        lorUrl: lorUrl || (profile.workExperience[0] ? profile.workExperience[0].lorUrl : '')
      }];
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
    if (files['resume']) {
      profile.resumeUrl = `/uploads/resumes/${files['resume'][0].filename}`;
    }
    if (files['certificates']) {
      files['certificates'].forEach(file => {
        profile.certificates.push({
          title: "Certificate",
          fileUrl: `/uploads/certificates/${file.filename}`
        });
      });
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
    const { role, location, company } = req.query;
    let filter = {};
    if (role) filter.roleType = role;
    if (location) filter.location = new RegExp(location, 'i');
    if (company) filter.company = new RegExp(company, 'i');
    
    const jobs = await Job.find(filter).sort({ createdAt: -1 });
    res.render('student/jobs', { jobs, filters: req.query });
  } catch (e) {
    console.error(e);
    res.redirect('/student/profile');
  }
});

app.get('/student/jobs/:id', isLoggedIn, isStudent, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    const profile = await StudentProfile.findOne({ user: req.user._id });
    const existingApplication = await Application.findOne({ job: job._id, student: req.user._id });
    res.render('student/job-detail', { job, profile, existingApplication });
  } catch (e) {
    console.error(e);
    res.redirect('/student/jobs');
  }
});

app.post('/student/jobs/:id/apply', isLoggedIn, isStudent, applicationUpload, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    const profile = await StudentProfile.findOne({ user: req.user._id });

    let resumeUrl = profile.resumeUrl;
    if (req.file) {
      resumeUrl = `/uploads/applications/${req.file.filename}`;
    }
    if (!resumeUrl) {
      return res.redirect(`/student/jobs/${req.params.id}`);
    }

    const newApplication = new Application({
      job: job._id,
      student: req.user._id,
      appliedResumeUrl: resumeUrl,
      profileSnapshot: {
        fullName: `${profile.personal.firstName} ${profile.personal.lastName}`,
        email: req.user.email,
        branch: profile.currentCourse.branch,
        cgpa: profile.currentCourse.aggregatePercentage
      }
    });
    
    await newApplication.save();
    res.redirect('/student/applications');
  } catch (e) {
    console.error(e);
    res.redirect('/student/jobs');
  }
});

app.get('/student/applications', isLoggedIn, isStudent, async (req, res) => {
  try {
    const applications = await Application.find({ student: req.user._id })
      .populate('job')
      .sort({ createdAt: -1 });
    res.render('student/applications', { applications });
  } catch (e) {
    console.error(e);
    res.redirect('/student/profile');
  }
});

app.get('/student/resume-builder', isLoggedIn, isStudent, async (req, res) => {
  try {
    const profile = await StudentProfile.findOne({ user: req.user._id }).populate('user', 'email');
    res.render('student/resume-builder', { profile });
  } catch (e) {
    console.error(e);
    res.redirect('/student/profile');
  }
});

app.post('/student/resume-builder/ai-review', isLoggedIn, isStudent, async (req, res) => {
  try {
    const profile = await StudentProfile.findOne({ user: req.user._id }).populate('user', 'email');
    
    let resumeText = `
      Full Name: ${profile.personal.firstName} ${profile.personal.middleName} ${profile.personal.lastName}
      Contact: ${profile.user.email}, ${profile.personal.contactNumber}
      LinkedIn: ${profile.personal.linkedIn}
      GitHub: ${profile.personal.github}

      --- EDUCATION ---
      Degree: ${profile.currentCourse.degree} in ${profile.currentCourse.department} (${profile.currentCourse.branch})
      Graduation Year: ${profile.currentCourse.graduationYear} (${profile.currentCourse.isPursuing ? 'Pursuing' : 'Completed'})
      Aggregate Percentage: ${profile.currentCourse.aggregatePercentage}%
      12th Percentage: ${profile.education.twelfthPercentage}%
      10th Percentage: ${profile.education.tenthPercentage}%

      --- SKILLS ---
      Technical Skills: ${profile.skills.technical.join(', ')}
      Soft Skills: ${profile.skills.soft.join(', ')}

      --- PROJECTS ---
      ${profile.projects.map(p => `
        Project: ${p.title}
        Description: ${p.description}
        URL: ${p.url}
      `).join('\n')}

      --- WORK EXPERIENCE ---
      ${profile.workExperience.map(exp => `
        Company: ${exp.company}
        Role: ${exp.role}
        Duration: ${exp.duration}
        Technologies: ${exp.technologiesUsed.join(', ')}
        Description: ${exp.description}
      `).join('\n')}

      --- EXTRACURRICULAR ---
      ${profile.extracurricular.join(', ')}

      --- HOBBIES ---
      ${profile.personal.hobbies.join(', ')}
    `;

    const prompt = `Please act as a professional career coach. Review the following resume for a student applying for a tech job. Provide 3-5 concise, actionable bullet points for improvement. Focus on clarity, impact, and how to better present their projects and experience. Format the response as a simple bulleted list (e.g., using * or -).
    
    --- RESUME ---
    ${resumeText}
    --- END RESUME ---
    `;
    
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const aiText = response.text();

    res.json({ success: true, review: aiText });

  } catch (e) {
    console.error("AI Review Error:", e);
    res.json({ success: false, review: "An error occurred while generating the AI review. Please check the server console." });
  }
});


// --- Admin Routes ---

app.get('/admin/dashboard', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const [totalStudents, totalJobs, placedApplications, allApplications] = await Promise.all([
      User.countDocuments({ role: 'student' }),
      Job.countDocuments(),
      Application.find({ status: 'Selected' }).populate('student').populate('job'),
      Application.find()
    ]);

    let totalPlaced = placedApplications.length;
    let highestPackage = 0;
    let packageSum = 0;

    placedApplications.forEach(app => {
      const ctcString = app.job.ctc.toLowerCase().replace('lpa', '').trim();
      const ctcValue = parseFloat(ctcString);
      if (!isNaN(ctcValue)) {
        packageSum += ctcValue;
        if (ctcValue > highestPackage) {
          highestPackage = ctcValue;
        }
      }
    });
    const averagePackage = totalPlaced > 0 ? (packageSum / totalPlaced).toFixed(2) : 0;
    const packageData = placedApplications
      .map(app => parseFloat(app.job.ctc.toLowerCase().replace('lpa', '').trim()))
      .filter(val => !isNaN(val));

    const stats = {
      totalStudents,
      totalJobs,
      totalApplications: allApplications.length,
      totalPlaced,
      averagePackage,
      highestPackage
    };

    res.render('admin/dashboard', { 
      stats, 
      placedStudents: placedApplications, 
      packageData: JSON.stringify(packageData)
    });
  } catch (e) {
    console.error(e);
    res.send("Error loading admin dashboard.");
  }
});

app.get('/admin/jobs', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const jobs = await Job.find({}).sort({ createdAt: -1 });
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

app.put('/admin/jobs/:id', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const { title, company, location, ctc, description, roleType } = req.body;
    await Job.findByIdAndUpdate(req.params.id, {
      title,
      company,
      location,
      ctc,
      description,
      roleType
    });
    res.redirect('/admin/jobs');
  } catch (e) {
    console.error(e);
    res.redirect(`/admin/jobs/${req.params.id}/edit`);
  }
});

app.delete('/admin/jobs/:id', isLoggedIn, isAdmin, async (req, res) => {
  try {
    await Job.findByIdAndDelete(req.params.id);
    res.redirect('/admin/jobs');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/jobs');
  }
});

app.get('/admin/jobs/:id/manage', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    const applications = await Application.find({ job: req.params.id })
      .populate({
        path: 'student',
        select: 'username email studentProfile',
        populate: {
          path: 'studentProfile',
          select: 'fullName academic'
        }
      });
      
    res.render('admin/manage-job', { job, applications });
  } catch (e) {
    console.error(e);
    res.redirect('/admin/dashboard');
  }
});

app.post('/admin/applications/:appId/status', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const application = await Application.findByIdAndUpdate(req.params.appId, { status });
    res.redirect(`/admin/jobs/${application.job}/manage`);
  } catch (e) {
    console.error(e);
    res.redirect('/admin/dashboard');
  }
});
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
app.get('/admin/students/:id', isLoggedIn, isAdmin, async (req, res) => {
  try {
    const studentUser = await User.findById(req.params.id);
    if (!studentUser || studentUser.role !== 'student') {
      req.flash('error', 'Student not found.');
      return res.redirect('/admin/students');
    }

    // Find the profile and all applications for this student
    const [profile, applications] = await Promise.all([
      StudentProfile.findOne({ user: studentUser._id }).populate('user', 'email'),
      Application.find({ student: studentUser._id }).populate('job').sort({ createdAt: -1 })
    ]);

    res.render('admin/student-detail', { profile, applications });
  } catch (e) {
    console.error(e);
    req.flash('error', 'Error fetching student details: ' + e.message);
    res.redirect('/admin/students');
  }
});

// === NEW STUDENT-CENTRIC ROUTES END ===

// =================================================================
//                        SERVER START
// =================================================================
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
