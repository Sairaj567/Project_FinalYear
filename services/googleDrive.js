const { google } = require('googleapis');
const { PassThrough } = require('stream');
const path = require('path');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://developers.google.com/oauthplayground'
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });

const bufferToStream = (buffer) => {
  const stream = new PassThrough();
  stream.end(buffer);
  return stream;
};

async function ensurePublicAccess(fileId) {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });
  } catch (error) {
    if (error && error.code === 403) {
      throw new Error('Unable to set public permissions on Drive file.');
    }
    if (!(error && error.code === 400)) {
      throw error;
    }
  }
}

async function uploadFileToDrive({ buffer, mimeType, originalName, folderId, makePublic = true }) {
  if (!buffer) {
    throw new Error('Missing buffer for Drive upload.');
  }
  if (!mimeType) {
    throw new Error('Missing MIME type for Drive upload.');
  }
  if (!folderId) {
    throw new Error('Drive folder ID is not configured.');
  }

  const extension = path.extname(originalName || '') || '';
  const baseName = path.parse(originalName || 'document').name
    .replace(/[^a-z0-9-_\s]/gi, '_')
    .trim() || 'document';
  const safeName = `${baseName}-${Date.now()}${extension}`;

  const createResponse = await drive.files.create({
    requestBody: {
      name: safeName,
      parents: [folderId]
    },
    media: {
      mimeType,
      body: bufferToStream(buffer)
    },
    fields: 'id, name, mimeType, webViewLink, webContentLink'
  });

  const { id } = createResponse.data;

  if (makePublic) {
    await ensurePublicAccess(id);
  }

  const { data } = await drive.files.get({
    fileId: id,
    fields: 'id, name, mimeType, webViewLink, webContentLink'
  });

  return {
    id: data.id,
    name: data.name,
    mimeType: data.mimeType,
    webViewLink: data.webViewLink,
    webContentLink: data.webContentLink,
    downloadUrl: `https://drive.google.com/uc?id=${data.id}&export=download`
  };
}

async function deleteFileFromDrive(fileId) {
  if (!fileId) {
    return;
  }
  try {
    await drive.files.delete({ fileId });
  } catch (error) {
    if (error && error.code === 404) {
      return;
    }
    throw error;
  }
}

module.exports = {
  uploadFileToDrive,
  deleteFileFromDrive
};
