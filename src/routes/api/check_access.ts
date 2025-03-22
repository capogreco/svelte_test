import type { RequestHandler } from '@sveltejs/kit';
import admin from 'firebase-admin';

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

export const post: RequestHandler = async ({ request }) => {
  const { email } = await request.json();
  const token = request.headers.get('Authorization')?.split('Bearer ')[1];

  if (!token) {
    return {
      status: 401,
      body: { message: 'Unauthorized' }
    };
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    const allowedUserEmail = 'alloweduser@example.com'; // Replace with the specific user's email

    if (decodedToken.email === allowedUserEmail) {
      return {
        status: 200,
        body: { message: 'Access granted' }
      };
    } else {
      return {
        status: 403,
        body: { message: 'Access denied' }
      };
    }
  } catch (error) {
    return {
      status: 401,
      body: { message: 'Unauthorized' }
    };
  }
};