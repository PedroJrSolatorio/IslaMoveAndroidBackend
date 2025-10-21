const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK
// You'll need to download your service account key from Firebase Console
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const auth = admin.auth();

// Middleware to verify Firebase ID token
async function verifyToken(req, res, next) {
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  
  if (!idToken) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    req.user = decodedToken;
    
    // Check if user is admin
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    if (!userDoc.exists || userDoc.data().userType !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Delete user endpoint
app.delete('/api/users/:userId', verifyToken, async (req, res) => {
  const { userId } = req.params;
  
  try {
    // Prevent deleting self
    if (userId === req.user.uid) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Check if user exists in Firestore
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found in database' });
    }

    // Prevent deleting other admins
    if (userDoc.data().userType === 'ADMIN') {
      return res.status(403).json({ error: 'Cannot delete admin users' });
    }

    // Delete from Firebase Authentication
    try {
      await auth.deleteUser(userId);
      console.log(`Deleted user ${userId} from Authentication`);
    } catch (authError) {
      if (authError.code === 'auth/user-not-found') {
        console.log(`User ${userId} not found in Authentication, continuing...`);
      } else {
        throw authError;
      }
    }

    // Delete from Firestore using batch
    const batch = db.batch();
    
    // Delete user document
    batch.delete(db.collection('users').doc(userId));
    
    // Delete driver document if exists
    batch.delete(db.collection('drivers').doc(userId));
    
    // Delete rating stats if exists
    batch.delete(db.collection('user_rating_stats').doc(userId));
    
    await batch.commit();

    // Delete related subcollections (optional - can be done in background)
    // Delete ratings
    const ratingsSnapshot = await db.collection('ratings')
      .where('fromUserId', '==', userId)
      .get();
    
    const ratingsBatch = db.batch();
    ratingsSnapshot.docs.forEach(doc => {
      ratingsBatch.delete(doc.ref);
    });
    await ratingsBatch.commit();

    // Delete pending ratings
    const pendingRatingsSnapshot = await db.collection('pending_ratings')
      .where('fromUserId', '==', userId)
      .get();
    
    const pendingBatch = db.batch();
    pendingRatingsSnapshot.docs.forEach(doc => {
      pendingBatch.delete(doc.ref);
    });
    await pendingBatch.commit();

    res.json({ 
      success: true, 
      message: 'User deleted successfully',
      userId: userId
    });

  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ 
      error: 'Failed to delete user',
      details: error.message 
    });
  }
});

// Disable user endpoint (soft delete alternative)
app.patch('/api/users/:userId/disable', verifyToken, async (req, res) => {
  const { userId } = req.params;
  
  try {
    // Disable in Firebase Authentication
    await auth.updateUser(userId, { disabled: true });
    
    // Update Firestore
    await db.collection('users').doc(userId).update({
      isDeleted: true,
      deletedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedBy: req.user.uid,
      status: 'DISABLED'
    });

    res.json({ 
      success: true, 
      message: 'User disabled successfully' 
    });

  } catch (error) {
    console.error('Error disabling user:', error);
    res.status(500).json({ 
      error: 'Failed to disable user',
      details: error.message 
    });
  }
});

// Get all users endpoint (optional)
app.get('/api/users', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    res.json({ users });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});