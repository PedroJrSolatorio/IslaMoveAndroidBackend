const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Initialize Firebase Admin SDK
// You'll need to download your service account key from Firebase Console
// const serviceAccount = require('./serviceAccountKey.json'); //Running locally
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY); //Running on Render

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
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Middleware to verify admin access
async function verifyAdmin(req, res, next) {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists || userDoc.data().userType !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (error) {
    console.error('Admin verification error:', error);
    return res.status(500).json({ error: 'Failed to verify admin access' });
  }
}

app.get('/api/cloudinary/test', (req, res) => {
  res.json({ 
    status: 'Cloudinary endpoints available',
    cloudinaryConfigured: !!(process.env.CLOUDINARY_CLOUD_NAME && 
                             process.env.CLOUDINARY_API_KEY && 
                             process.env.CLOUDINARY_API_SECRET)
  });
});

// ==================== CLOUDINARY SECURE UPLOAD ENDPOINTS ====================

/**
 * Generate signed upload parameters for registration (no auth required)
 * Only allows id_document uploads during registration
 */
app.post('/api/cloudinary/sign-upload-registration', async (req, res) => {
  try {
    const { uploadType, tempUserId } = req.body;
    
    // Only allow id_document for registration
    if (uploadType !== 'id_document') {
      return res.status(400).json({ error: 'Only ID document uploads allowed during registration' });
    }

    if (!tempUserId || tempUserId.length < 10) {
      return res.status(400).json({ error: 'Invalid temporary user ID' });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const publicId = `islamove/${uploadType}/temp_${tempUserId}_${timestamp}`;

    // FIXED: Include all parameters that will be sent to Cloudinary
    const uploadParams = {
      folder: `islamove/${uploadType}`,
      public_id: publicId,
      timestamp: timestamp,
      type: 'authenticated'  // CRITICAL: Must be in signature
    };

    // Generate signature with these exact parameters
    const signature = cloudinary.utils.api_sign_request(
      uploadParams,
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      signature: signature,
      timestamp: timestamp,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      publicId: publicId,
      folder: uploadParams.folder
      // uploadPreset removed - not needed for signed uploads
    });

  } catch (error) {
    console.error('Error generating registration upload signature:', error);
    res.status(500).json({ 
      error: 'Failed to generate upload signature',
      details: error.message 
    });
  }
});

/**
 * Generate signed upload parameters for authenticated users
 */
app.post('/api/cloudinary/sign-upload', verifyToken, async (req, res) => {
  try {
    const { uploadType } = req.body;
    const userId = req.user.uid;

    // Validate upload type
    const validUploadTypes = ['id_document', 'profile_photo', 'vehicle_photo', 'student_document'];
    if (!uploadType || !validUploadTypes.includes(uploadType)) {
      return res.status(400).json({ error: 'Invalid upload type' });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const publicId = `${userId}_${timestamp}`; // Don't include folder here

    // FIXED: Include all parameters that will be sent to Cloudinary
    const uploadParams = {
      folder: `islamove/${uploadType}`,
      public_id: publicId, // Just the filename part
      timestamp: timestamp,
      type: 'authenticated'  // CRITICAL: Must be in signature
    };

    // Generate signature with these exact parameters
    const signature = cloudinary.utils.api_sign_request(
      uploadParams,
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      signature: signature,
      timestamp: timestamp,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      publicId: publicId,
      folder: uploadParams.folder
      // uploadPreset removed - not needed for signed uploads
    });

  } catch (error) {
    console.error('Error generating upload signature:', error);
    res.status(500).json({ 
      error: 'Failed to generate upload signature',
      details: error.message 
    });
  }
});

/**
 * Verify and save uploaded image URL to database
 */
app.post('/api/cloudinary/verify-upload', verifyToken, async (req, res) => {
  try {
    const { publicId, uploadType, secureUrl } = req.body;
    const userId = req.user.uid;

    if (!publicId.includes(userId)) {
      return res.status(403).json({ error: 'Unauthorized access to resource' });
    }

    try {
      const result = await cloudinary.api.resource(publicId, {
        resource_type: 'image',
        type: 'authenticated'
      });

      // FIXED: Remove updatedAt timestamp
      const updateData = {};

      if (uploadType === 'id_document') {
        updateData.idDocumentUrl = result.secure_url;
        updateData.idDocumentPublicId = publicId;
      } else if (uploadType === 'profile_photo') {
        updateData.photoURL = result.secure_url;
        updateData.profilePhotoPublicId = publicId;
      } else if (uploadType === 'vehicle_photo') {
        updateData['driverData.vehiclePhotoUrl'] = result.secure_url;
        updateData['driverData.vehiclePhotoPublicId'] = publicId;
      } else if (uploadType === 'student_document') {
        updateData.studentDocumentUrl = result.secure_url;
        updateData.studentDocumentPublicId = publicId;
      }

      await db.collection('users').doc(userId).update(updateData);

      res.json({
        success: true,
        message: 'Upload verified and saved',
        secureUrl: result.secure_url,
        publicId: publicId
      });

    } catch (cloudinaryError) {
      console.error('Cloudinary verification error:', cloudinaryError);
      
      // FIXED: Remove updatedAt timestamp from fallback too
      const updateData = {};

      if (uploadType === 'id_document') {
        updateData.idDocumentUrl = secureUrl;
        updateData.idDocumentPublicId = publicId;
      } else if (uploadType === 'profile_photo') {
        updateData.photoURL = secureUrl;
        updateData.profilePhotoPublicId = publicId;
      } else if (uploadType === 'vehicle_photo') {
        updateData['driverData.vehiclePhotoUrl'] = secureUrl;
        updateData['driverData.vehiclePhotoPublicId'] = publicId;
      } else if (uploadType === 'student_document') {
        updateData.studentDocumentUrl = secureUrl;
        updateData.studentDocumentPublicId = publicId;
      }

      await db.collection('users').doc(userId).update(updateData);

      res.json({
        success: true,
        message: 'Upload saved (verification skipped)',
        secureUrl: secureUrl,
        publicId: publicId
      });
    }

  } catch (error) {
    console.error('Error verifying upload:', error);
    res.status(500).json({ 
      error: 'Failed to verify upload',
      details: error.message 
    });
  }
});

/**
 * Generate signed URL for viewing private images
 * This allows temporary access to authenticated images
 */
app.post('/api/cloudinary/get-signed-url', verifyToken, async (req, res) => {
  try {
    const { publicId } = req.body;
    const userId = req.user.uid;

    // Get user document to check permissions
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const isAdmin = userData.userType === 'ADMIN';

    // Check if user has permission to view this image
    // Users can view their own images, admins can view all
    if (!isAdmin && !publicId.includes(userId)) {
      return res.status(403).json({ error: 'Unauthorized access to resource' });
    }

    // Generate signed URL (valid for 1 hour)
    const signedUrl = cloudinary.utils.private_download_url(
      publicId,
      'jpg',
      {
        resource_type: 'image',
        type: 'authenticated',
        expires_at: Math.round(Date.now() / 1000) + 3600 // 1 hour
      }
    );

    res.json({
      signedUrl: signedUrl,
      expiresIn: 3600 // seconds
    });

  } catch (error) {
    console.error('Error generating signed URL:', error);
    res.status(500).json({ 
      error: 'Failed to generate signed URL',
      details: error.message 
    });
  }
});

/**
 * Delete image from Cloudinary
 * Only the owner or admin can delete
 */
app.delete('/api/cloudinary/delete/:publicId', verifyToken, async (req, res) => {
  try {
    const publicId = decodeURIComponent(req.params.publicId);
    const userId = req.user.uid;

    // Get user document to check if admin
    const userDoc = await db.collection('users').doc(userId).get();
    const isAdmin = userDoc.exists && userDoc.data().userType === 'ADMIN';

    // Check permission
    if (!isAdmin && !publicId.includes(userId)) {
      return res.status(403).json({ error: 'Unauthorized to delete this resource' });
    }

    // Delete from Cloudinary
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image',
      type: 'upload',
      invalidate: true
    });

    if (result.result === 'ok' || result.result === 'not found') {
      res.json({
        success: true,
        message: 'Image deleted successfully',
        result: result.result
      });
    } else {
      throw new Error('Failed to delete image');
    }

  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ 
      error: 'Failed to delete image',
      details: error.message 
    });
  }
});

// ==================== OTHER ENDPOINTS ====================

app.get('/', (req, res) => {
  res.send('🚀 Server is running! Try /health or your /api routes.');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Update user password endpoint
app.put('/api/users/:userId/password', verifyToken, async (req, res) => {
  const { userId } = req.params;
  const { newPassword, adminId } = req.body;
  
  try {
    // Validate input
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Prevent changing own password through this endpoint
    if (userId === req.user.uid) {
      return res.status(400).json({ error: 'Cannot change your own password through admin panel' });
    }

    // Verify adminId matches the authenticated user
    if (adminId !== req.user.uid) {
      return res.status(403).json({ error: 'Admin ID mismatch' });
    }

    // Check if user exists in Firestore
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found in database' });
    }

    // Prevent changing other admin passwords
    if (userDoc.data().userType === 'ADMIN') {
      return res.status(403).json({ error: 'Cannot change admin user passwords' });
    }

    // Update password in Firebase Authentication
    await auth.updateUser(userId, {
      password: newPassword
    });

    console.log(`Updated password for user ${userId} by admin ${adminId}`);

    // Update Firestore (for compatibility - storing plain text passwords is not recommended in production)
    await db.collection('users').doc(userId).update({
      plainTextPassword: newPassword,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      passwordUpdatedBy: adminId
    });

    res.json({ 
      success: true, 
      message: 'Password updated successfully',
      userId: userId
    });

  } catch (error) {
    console.error('Error updating password:', error);
    res.status(500).json({ 
      error: 'Failed to update password',
      details: error.message 
    });
  }
});

// Delete user endpoint
app.delete('/api/users/:userId', verifyToken, verifyAdmin, async (req, res) => {
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

    const userData = userDoc.data();

    // Delete associated Cloudinary images
    const imagesToDelete = [];
    if (userData.idDocumentPublicId) imagesToDelete.push(userData.idDocumentPublicId);
    if (userData.profilePhotoPublicId) imagesToDelete.push(userData.profilePhotoPublicId);
    if (userData.driverData?.vehiclePhotoPublicId) {
      imagesToDelete.push(userData.driverData.vehiclePhotoPublicId);
    }

    // Delete images from Cloudinary
    for (const publicId of imagesToDelete) {
      try {
        await cloudinary.uploader.destroy(publicId, {
          resource_type: 'image',
          invalidate: true
        });
      } catch (cloudinaryError) {
        console.error(`Failed to delete image ${publicId}:`, cloudinaryError);
      }
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

// Disable user endpoint (soft delete alternative) - not yet implemented
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

// Update user rating after new rating submission
app.post('/api/ratings/:ratingId/update-stats', async (req, res) => {
  const { ratingId } = req.params;
  const { toUserId, stars, fromUserId } = req.body;
  
  console.log('=== UPDATE RATING STATS REQUEST ===');
  console.log('Rating ID:', ratingId);
  console.log('To User ID:', toUserId);
  console.log('Stars:', stars);
  console.log('From User ID:', fromUserId);
  
  try {
    // Validate input
    if (!toUserId || !stars || stars < 1 || stars > 5) {
      console.error('Validation failed:', { toUserId, stars });
      return res.status(400).json({ error: 'Invalid rating data' });
    }

    // Verify the rating exists
    console.log('Checking if rating exists...');
    const ratingDoc = await db.collection('ratings').doc(ratingId).get();
    if (!ratingDoc.exists) {
      console.error('Rating not found:', ratingId);
      return res.status(404).json({ error: 'Rating not found' });
    }
    
    const ratingData = ratingDoc.data();
    console.log('Rating data:', ratingData);
    
    // Verify the request is for the correct user
    if (ratingData.toUserId !== toUserId) {
      console.error('User mismatch. Expected:', ratingData.toUserId, 'Got:', toUserId);
      return res.status(403).json({ error: 'User mismatch' });
    }

    // Get or create user rating stats
    console.log('Fetching user rating stats...');
    const statsRef = db.collection('user_rating_stats').doc(toUserId);
    const statsDoc = await statsRef.get();
    
    let newStats;
    if (statsDoc.exists) {
      console.log('Existing stats found:', statsDoc.data());
      const currentStats = statsDoc.data();
      const totalRatings = currentStats.totalRatings + 1;
      const newAverage = ((currentStats.overallRating * currentStats.totalRatings) + stars) / totalRatings;
      
      // Update rating breakdown
      const breakdown = currentStats.ratingBreakdown || {
        fiveStars: 0,
        fourStars: 0,
        threeStars: 0,
        twoStars: 0,
        oneStar: 0
      };
      
      if (stars === 5) breakdown.fiveStars++;
      else if (stars === 4) breakdown.fourStars++;
      else if (stars === 3) breakdown.threeStars++;
      else if (stars === 2) breakdown.twoStars++;
      else if (stars === 1) breakdown.oneStar++;
      
      newStats = {
        overallRating: parseFloat(newAverage.toFixed(1)),
        totalRatings: totalRatings,
        ratingBreakdown: breakdown,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      };
    } else {
      console.log('No existing stats, creating new...');
      // First rating for this user
      const breakdown = {
        fiveStars: stars === 5 ? 1 : 0,
        fourStars: stars === 4 ? 1 : 0,
        threeStars: stars === 3 ? 1 : 0,
        twoStars: stars === 2 ? 1 : 0,
        oneStar: stars === 1 ? 1 : 0
      };
      
      newStats = {
        userId: toUserId,
        overallRating: parseFloat(stars.toFixed(1)),
        totalRatings: 1,
        ratingBreakdown: breakdown,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      };
    }
    
    console.log('New stats to save:', newStats);
    
    // Update user_rating_stats collection
    await statsRef.set(newStats, { merge: true });
    console.log('✓ user_rating_stats updated');
    
    // Get user document to check user type
    console.log('Fetching user document...');
    const userDoc = await db.collection('users').doc(toUserId).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      console.log('User type:', userData.userType);
      
      // Update the rating in users collection based on user type
      if (userData.userType === 'DRIVER') {
        console.log('Updating DRIVER rating...');
        const driverData = userData.driverData || {};
        await db.collection('users').doc(toUserId).update({
          'driverData.rating': parseFloat(newStats.overallRating.toFixed(1)),
          'driverData.totalRatings': newStats.totalRatings,
          ...driverData,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✓ DRIVER rating updated: ${newStats.overallRating}`);
      } else if (userData.userType === 'PASSENGER') {
        console.log('Updating PASSENGER rating...');
        await db.collection('users').doc(toUserId).update({
          passengerRating: parseFloat(newStats.overallRating.toFixed(1)),
          passengerTotalTrips: newStats.totalRatings,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✓ PASSENGER rating updated: ${newStats.overallRating}`);
      }
    } else {
      console.error('User document not found:', toUserId);
    }

    console.log('=== RATING STATS UPDATE COMPLETE ===\n');

    res.json({ 
      success: true, 
      message: 'Rating stats updated successfully',
      stats: newStats
    });

  } catch (error) {
    console.error('=== ERROR UPDATING RATING STATS ===');
    console.error('Error:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to update rating stats',
      details: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});