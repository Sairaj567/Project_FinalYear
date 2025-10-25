const REQUIRED_ENV_VARS = [
  'MONGO_URI',
  'SESSION_SECRET',
  'GEMINI_API_KEY',
  'N8N_WEBHOOK_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_DRIVE_ROOT_FOLDER_ID'
];

function validateEnv() {
  const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }

  if (process.env.GOOGLE_REDIRECT_URI && !process.env.GOOGLE_REDIRECT_URI.startsWith('http')) {
    throw new Error('GOOGLE_REDIRECT_URI must be a valid URL when defined.');
  }

  if (process.env.PORT && Number.isNaN(Number.parseInt(process.env.PORT, 10))) {
    throw new Error('PORT must be a valid number when defined.');
  }
}

module.exports = {
  validateEnv,
  REQUIRED_ENV_VARS
};
