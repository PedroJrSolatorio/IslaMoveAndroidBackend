const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;
require("dotenv").config();
const cron = require("node-cron");

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  "https://islamove-admin.vercel.app",
];

// CORS configuration - MORE PERMISSIVE
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log("Blocked origin:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  exposedHeaders: ["Content-Length", "Content-Type"],
  maxAge: 86400, // 24 hours
};

// Apply CORS middleware BEFORE other middleware
app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options("*", cors(corsOptions));

// Body parser middleware
app.use(express.json());

// Configure Cloudinary (add after Firebase initialization)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Initialize Firebase Admin SDK
// You'll need to download your service account key from Firebase Console
// const serviceAccount = require('./serviceAccountKey.json'); //Running locally
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY); //Running on Render

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

// Usage tracking
let mapboxMonthlyUsage = {
  directions: 0,
  geocoding: 0,
  lastReset: Date.now(),
  monthlyLimit: parseInt(process.env.MAPBOX_MONTHLY_LIMIT) || 100000, // Free tier limit
  alerts: {
    warned75: false,
    warned90: false,
    warned95: false,
  },
};

// Load usage from Firebase on startup
async function loadMapboxUsage() {
  try {
    const usageDoc = await db
      .collection("system_config")
      .doc("mapbox_usage")
      .get();
    if (usageDoc.exists) {
      const data = usageDoc.data();
      const now = Date.now();
      const monthInMs = 30 * 24 * 60 * 60 * 1000;

      // Reset if it's been more than a month
      if (now - data.lastReset > monthInMs) {
        console.log("📊 Monthly Mapbox usage reset");
        console.log(
          `📈 Last month usage: Directions: ${data.directions}, Geocoding: ${
            data.geocoding
          }, Total: ${data.directions + data.geocoding}`
        );

        // Send monthly report before reset
        await sendMonthlyReport(data);

        mapboxMonthlyUsage = {
          directions: 0,
          geocoding: 0,
          lastReset: now,
          monthlyLimit: parseInt(process.env.MAPBOX_MONTHLY_LIMIT) || 100000,
          alerts: { warned75: false, warned90: false, warned95: false },
        };
        await saveMapboxUsage();
      } else {
        mapboxMonthlyUsage = {
          ...data,
          monthlyLimit: parseInt(process.env.MAPBOX_MONTHLY_LIMIT) || 100000,
        };
        console.log("📊 Loaded existing Mapbox usage:", {
          total: data.directions + data.geocoding,
          limit: mapboxMonthlyUsage.monthlyLimit,
        });
      }
    } else {
      console.log("📊 Initializing new Mapbox usage tracking");
      await saveMapboxUsage();
    }
  } catch (error) {
    console.error("❌ Error loading Mapbox usage:", error);
  }
}

// Save usage to Firebase
async function saveMapboxUsage() {
  try {
    await db
      .collection("system_config")
      .doc("mapbox_usage")
      .set({
        ...mapboxMonthlyUsage,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
  } catch (error) {
    console.error("❌ Error saving Mapbox usage:", error);
  }
}

// Check if usage limit is exceeded
function checkMapboxUsageLimit(apiType = "directions") {
  const totalUsage =
    mapboxMonthlyUsage.directions + mapboxMonthlyUsage.geocoding;
  const usagePercent = (totalUsage / mapboxMonthlyUsage.monthlyLimit) * 100;

  // Send alerts at different thresholds
  if (usagePercent >= 95 && !mapboxMonthlyUsage.alerts.warned95) {
    console.error("🚨🚨🚨 CRITICAL: Mapbox usage at 95%!");
    sendAlertEmail(
      "CRITICAL: Mapbox API Usage at 95% - IMMEDIATE ACTION REQUIRED",
      `Your Mapbox API usage has reached 95% of the monthly limit!
      
Usage: ${totalUsage.toLocaleString()} / ${mapboxMonthlyUsage.monthlyLimit.toLocaleString()} requests
Remaining: ${(
        mapboxMonthlyUsage.monthlyLimit - totalUsage
      ).toLocaleString()} requests

⚠️ API calls will be blocked at 95% to prevent overage charges.

Breakdown:
- Directions API: ${mapboxMonthlyUsage.directions.toLocaleString()} requests
- Geocoding API: ${mapboxMonthlyUsage.geocoding.toLocaleString()} requests

Action Required:
1. Check for unusual usage patterns in your dashboard
2. Consider upgrading your Mapbox plan
3. Implement additional caching
4. Review your API usage logs

Dashboard: https://account.mapbox.com/

This is an automated alert from your IslaMove backend.`
    );
    mapboxMonthlyUsage.alerts.warned95 = true;
    saveMapboxUsage();
  } else if (usagePercent >= 90 && !mapboxMonthlyUsage.alerts.warned90) {
    console.error("🚨 CRITICAL: Mapbox usage at 90%!");
    sendAlertEmail(
      "CRITICAL: Mapbox API Usage at 90%",
      `Your Mapbox API usage has reached 90% of the monthly limit.
      
Usage: ${totalUsage.toLocaleString()} / ${mapboxMonthlyUsage.monthlyLimit.toLocaleString()} requests
Remaining: ${(
        mapboxMonthlyUsage.monthlyLimit - totalUsage
      ).toLocaleString()} requests

Breakdown:
- Directions API: ${mapboxMonthlyUsage.directions.toLocaleString()} requests
- Geocoding API: ${mapboxMonthlyUsage.geocoding.toLocaleString()} requests

Recommended Actions:
1. Monitor usage closely over the next few days
2. Consider implementing stricter rate limits
3. Review caching strategies
4. Plan for potential upgrade if growth continues

Dashboard: https://account.mapbox.com/`
    );
    mapboxMonthlyUsage.alerts.warned90 = true;
    saveMapboxUsage();
  } else if (usagePercent >= 75 && !mapboxMonthlyUsage.alerts.warned75) {
    console.warn("⚠️ WARNING: Mapbox usage at 75%");
    sendAlertEmail(
      "WARNING: Mapbox API Usage at 75%",
      `Your Mapbox API usage has reached 75% of the monthly limit.
      
Usage: ${totalUsage.toLocaleString()} / ${mapboxMonthlyUsage.monthlyLimit.toLocaleString()} requests
Remaining: ${(
        mapboxMonthlyUsage.monthlyLimit - totalUsage
      ).toLocaleString()} requests

Breakdown:
- Directions API: ${mapboxMonthlyUsage.directions.toLocaleString()} requests
- Geocoding API: ${mapboxMonthlyUsage.geocoding.toLocaleString()} requests

This is a heads-up that you're approaching your monthly limit. No action required yet, but monitor usage.

Dashboard: https://account.mapbox.com/`
    );
    mapboxMonthlyUsage.alerts.warned75 = true;
    saveMapboxUsage();
  }

  // Hard limit at 95% to leave buffer and prevent overage charges
  if (totalUsage >= mapboxMonthlyUsage.monthlyLimit * 0.95) {
    console.error("🛑 Mapbox monthly limit exceeded (95%)!");
    return false;
  }

  return true;
}

// Track API call
async function trackMapboxCall(apiType = "directions") {
  mapboxMonthlyUsage[apiType]++;

  // Save to Firebase every 10 calls to reduce write operations
  if (
    (mapboxMonthlyUsage.directions + mapboxMonthlyUsage.geocoding) % 50 ===
    0
  ) {
    await saveMapboxUsage();
  }

  const totalUsage =
    mapboxMonthlyUsage.directions + mapboxMonthlyUsage.geocoding;
  const usagePercent = (
    (totalUsage / mapboxMonthlyUsage.monthlyLimit) *
    100
  ).toFixed(1);

  console.log(
    `📊 Mapbox ${apiType} call tracked. Total: ${totalUsage.toLocaleString()}/${mapboxMonthlyUsage.monthlyLimit.toLocaleString()} (${usagePercent}%)`
  );

  // Check thresholds after tracking
  checkMapboxUsageLimit(apiType);
}

// Send alert email using your existing Brevo setup
async function sendAlertEmail(subject, body) {
  try {
    const alertEmail = process.env.MAPBOX_ALERT_EMAIL;

    if (!alertEmail) {
      console.log("⚠️ MAPBOX_ALERT_EMAIL not configured, skipping email alert");
      console.log("Alert:", subject);
      return;
    }

    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      console.error("❌ BREVO_API_KEY not configured, cannot send alert email");
      return;
    }

    const brevoPayload = {
      sender: {
        name: "IslaMove Monitoring",
        email: "noreply@islamove.com",
      },
      to: [{ email: alertEmail }],
      subject: subject,
      htmlContent: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #f44336; color: white; padding: 20px; border-radius: 5px 5px 0 0;">
            <h2 style="margin: 0;">🚨 IslaMove Alert</h2>
          </div>
          <div style="background-color: #f5f5f5; padding: 20px; border-radius: 0 0 5px 5px;">
            <div style="background-color: white; padding: 20px; border-radius: 5px;">
              <pre style="white-space: pre-wrap; font-family: monospace; font-size: 14px;">${body}</pre>
            </div>
            <p style="margin-top: 20px; font-size: 12px; color: #666;">
              Timestamp: ${new Date().toISOString()}<br>
              Server: ${process.env.RENDER_BASE_URL || "Unknown"}
            </p>
          </div>
        </div>
      `,
    };

    const brevoResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(brevoPayload),
    });

    if (brevoResponse.ok) {
      console.log("✅ Alert email sent successfully");
    } else {
      const errorData = await brevoResponse.json();
      console.error("❌ Failed to send alert email:", errorData);
    }
  } catch (error) {
    console.error("❌ Error sending alert email:", error);
  }
}

// Send weekly report
async function sendWeeklyReport(stats) {
  try {
    const totalUsage = stats.directions + stats.geocoding;
    const usagePercent = ((totalUsage / stats.monthlyLimit) * 100).toFixed(1);
    const daysIntoMonth = Math.floor(
      (Date.now() - stats.lastReset) / (24 * 60 * 60 * 1000)
    );
    const projectedMonthlyUsage = Math.floor((totalUsage / daysIntoMonth) * 30);

    await sendAlertEmail(
      "📊 Weekly Mapbox API Usage Report",
      `IslaMove Mapbox API Usage - Week of ${new Date().toLocaleDateString()}

Current Usage:
- Total: ${totalUsage.toLocaleString()} / ${stats.monthlyLimit.toLocaleString()} (${usagePercent}%)
- Directions API: ${stats.directions.toLocaleString()} requests
- Geocoding API: ${stats.geocoding.toLocaleString()} requests

Progress:
- Days into month: ${daysIntoMonth} / 30
- Average daily usage: ${Math.floor(
        totalUsage / daysIntoMonth
      ).toLocaleString()} requests/day
- Projected monthly usage: ${projectedMonthlyUsage.toLocaleString()} requests

Status: ${
        usagePercent >= 90
          ? "🔴 CRITICAL - Approaching limit"
          : usagePercent >= 75
          ? "🟡 WARNING - Monitor closely"
          : usagePercent >= 50
          ? "🟢 GOOD - On track"
          : "🟢 EXCELLENT - Well under limit"
      }

${
  projectedMonthlyUsage > stats.monthlyLimit
    ? `⚠️ WARNING: At current rate, you will exceed your monthly limit by ${(
        projectedMonthlyUsage - stats.monthlyLimit
      ).toLocaleString()} requests.`
    : "✅ Projected usage is within monthly limit."
}

Dashboard: https://account.mapbox.com/
Backend: ${process.env.RENDER_BASE_URL || "Unknown"}/api/mapbox/usage`
    );

    console.log("✅ Weekly report sent");
  } catch (error) {
    console.error("❌ Error sending weekly report:", error);
  }
}

// Send monthly summary before reset
async function sendMonthlyReport(lastMonthData) {
  try {
    const totalUsage = lastMonthData.directions + lastMonthData.geocoding;
    const usagePercent = (
      (totalUsage / lastMonthData.monthlyLimit) *
      100
    ).toFixed(1);
    const estimatedCost =
      totalUsage > lastMonthData.monthlyLimit
        ? ((totalUsage - lastMonthData.monthlyLimit) / 1000) * 0.5
        : 0;

    await sendAlertEmail(
      "📈 Monthly Mapbox API Usage Summary",
      `IslaMove Mapbox API - Monthly Summary

Period: Last 30 days
Reset Date: ${new Date().toLocaleDateString()}

Final Usage:
- Total: ${totalUsage.toLocaleString()} / ${lastMonthData.monthlyLimit.toLocaleString()} (${usagePercent}%)
- Directions API: ${lastMonthData.directions.toLocaleString()} requests
- Geocoding API: ${lastMonthData.geocoding.toLocaleString()} requests

Performance:
${
  totalUsage <= lastMonthData.monthlyLimit
    ? "✅ Stayed within free tier limit"
    : `❌ Exceeded free tier by ${(
        totalUsage - lastMonthData.monthlyLimit
      ).toLocaleString()} requests`
}

Estimated Overage Cost: $${estimatedCost.toFixed(2)}

Average Daily Usage: ${Math.floor(
        totalUsage / 30
      ).toLocaleString()} requests/day

---

New Month Starting:
Your usage counter has been reset to 0.
Continue monitoring at: ${
        process.env.RENDER_BASE_URL || "Unknown"
      }/api/mapbox/usage`
    );

    console.log("✅ Monthly summary sent");
  } catch (error) {
    console.error("❌ Error sending monthly report:", error);
  }
}

// Initialize usage tracking on server start
loadMapboxUsage();

// ===== MAPBOX API ENDPOINTS =====

// Get current Mapbox usage stats
app.get("/api/mapbox/usage", async (req, res) => {
  try {
    const totalUsage =
      mapboxMonthlyUsage.directions + mapboxMonthlyUsage.geocoding;
    const usagePercent = (
      (totalUsage / mapboxMonthlyUsage.monthlyLimit) *
      100
    ).toFixed(1);
    const daysUntilReset = Math.ceil(
      (30 * 24 * 60 * 60 * 1000 - (Date.now() - mapboxMonthlyUsage.lastReset)) /
        (24 * 60 * 60 * 1000)
    );
    const daysIntoMonth = Math.floor(
      (Date.now() - mapboxMonthlyUsage.lastReset) / (24 * 60 * 60 * 1000)
    );
    const avgDailyUsage =
      daysIntoMonth > 0 ? Math.floor(totalUsage / daysIntoMonth) : 0;
    const projectedMonthlyUsage = avgDailyUsage * 30;

    res.json({
      usage: {
        directions: mapboxMonthlyUsage.directions,
        geocoding: mapboxMonthlyUsage.geocoding,
        total: totalUsage,
        limit: mapboxMonthlyUsage.monthlyLimit,
        remaining: Math.max(0, mapboxMonthlyUsage.monthlyLimit - totalUsage),
        percentUsed: parseFloat(usagePercent),
      },
      status:
        totalUsage >= mapboxMonthlyUsage.monthlyLimit * 0.95
          ? "CRITICAL"
          : totalUsage >= mapboxMonthlyUsage.monthlyLimit * 0.9
          ? "CRITICAL"
          : totalUsage >= mapboxMonthlyUsage.monthlyLimit * 0.75
          ? "WARNING"
          : "OK",
      daysUntilReset: Math.max(0, daysUntilReset),
      daysIntoMonth: daysIntoMonth,
      avgDailyUsage: avgDailyUsage,
      projectedMonthlyUsage: projectedMonthlyUsage,
      willExceedLimit: projectedMonthlyUsage > mapboxMonthlyUsage.monthlyLimit,
      lastReset: new Date(mapboxMonthlyUsage.lastReset).toISOString(),
    });
  } catch (error) {
    console.error("Error fetching usage:", error);
    res.status(500).json({ error: "Failed to fetch usage stats" });
  }
});

// Proxy endpoint for Mapbox Directions API with rate limiting
app.post("/api/mapbox/directions", async (req, res) => {
  try {
    // Check usage limit
    if (!checkMapboxUsageLimit("directions")) {
      console.log("Monthly API limit exceeded (95%), returning fallback");
      return res.status(429).json({
        error: "Monthly Mapbox API limit exceeded (95%)",
        fallback: true,
        message: "Using fallback route calculation to prevent overage charges",
      });
    }

    const { coordinates } = req.body;

    if (!coordinates) {
      console.error("No coordinates provided in request");
      return res.status(400).json({ error: "Coordinates required" });
    }

    const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN;
    if (!mapboxToken) {
      console.error("MAPBOX_ACCESS_TOKEN not configured");
      return res.status(500).json({ error: "Mapbox token not configured" });
    }

    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}?access_token=${mapboxToken}&geometries=polyline6&overview=full&steps=true`;

    const response = await fetch(url);
    const data = await response.json();

    console.log(`Mapbox API response: ${response.status}`);
    console.log(`Response has routes: ${data.routes ? data.routes.length : 0}`);

    if (response.ok) {
      // Track successful API call
      await trackMapboxCall("directions");
      console.log("Mapbox Directions API call successful");

      // Verify we have valid route data before sending
      if (data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        console.log(
          `Returning route with ${
            route.legs ? route.legs.length : 0
          } legs, distance: ${route.distance}m`
        );
      } else {
        console.warn("Mapbox returned success but no routes!");
      }

      res.json(data);
    } else {
      console.error(`Mapbox API error: ${response.status}`, data);
      res.status(response.status).json({
        error: "Mapbox API error",
        fallback: true,
        details: data,
      });
    }
  } catch (error) {
    console.error("Mapbox Directions API error:", error);
    res.status(500).json({
      error: "Failed to get directions",
      fallback: true,
    });
  }
});

// Proxy endpoint for Mapbox Geocoding API with rate limiting
app.post("/api/mapbox/geocode", async (req, res) => {
  try {
    // Check usage limit
    if (!checkMapboxUsageLimit("geocoding")) {
      return res.status(429).json({
        error: "Monthly Mapbox API limit exceeded (95%)",
        fallback: true,
      });
    }

    const { query, proximity } = req.body;

    if (!query) {
      return res.status(400).json({ error: "Query required" });
    }

    const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN;
    if (!mapboxToken) {
      return res.status(500).json({ error: "Mapbox token not configured" });
    }

    let url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
      query
    )}.json?access_token=${mapboxToken}&country=PH&types=region,district,locality,place`;

    if (proximity) {
      url += `&proximity=${proximity}`;
    }

    const response = await fetch(url);
    const data = await response.json();

    if (response.ok) {
      // Track successful API call
      await trackMapboxCall("geocoding");
    }

    res.json(data);
  } catch (error) {
    console.error("Mapbox Geocoding API error:", error);
    res.status(500).json({
      error: "Failed to geocode",
      fallback: true,
    });
  }
});

// Manual usage reset endpoint (admin only)
app.post("/api/mapbox/reset-usage", verifyToken, async (req, res) => {
  try {
    const oldUsage = { ...mapboxMonthlyUsage };

    mapboxMonthlyUsage = {
      directions: 0,
      geocoding: 0,
      lastReset: Date.now(),
      monthlyLimit: parseInt(process.env.MAPBOX_MONTHLY_LIMIT) || 100000,
      alerts: { warned75: false, warned90: false, warned95: false },
    };

    await saveMapboxUsage();

    console.log("📊 Manual usage reset by admin:", req.user.uid);
    console.log("Old usage:", oldUsage);

    res.json({
      success: true,
      message: "Usage reset successfully",
      oldUsage: {
        total: oldUsage.directions + oldUsage.geocoding,
        directions: oldUsage.directions,
        geocoding: oldUsage.geocoding,
      },
      newUsage: mapboxMonthlyUsage,
    });
  } catch (error) {
    console.error("Error resetting usage:", error);
    res.status(500).json({ error: "Failed to reset usage" });
  }
});

// ===== CRON JOBS =====

// Weekly report - Every Monday at 2 AM
cron.schedule(
  "0 2 * * 1",
  async () => {
    await sendWeeklyReport(mapboxMonthlyUsage);
  },
  { timezone: "Asia/Manila" }
);

// Monthly reset - once per day at midnight
cron.schedule(
  "0 0 * * *",
  async () => {
    const now = Date.now();
    const monthInMs = 30 * 24 * 60 * 60 * 1000;
    if (now - mapboxMonthlyUsage.lastReset > monthInMs) {
      await loadMapboxUsage();
    }
  },
  { timezone: "Asia/Manila" }
);

// =============OTHER API ENDPOINTS================

// Middleware to verify Firebase ID token (for regular authenticated users)
async function authenticateToken(req, res, next) {
  const idToken = req.headers.authorization?.split("Bearer ")[1];

  if (!idToken) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Token verification error:", error);
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Middleware to verify Firebase ID token AND check admin access
async function verifyToken(req, res, next) {
  const idToken = req.headers.authorization?.split("Bearer ")[1];

  if (!idToken) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    req.user = decodedToken;

    // Check if user is admin
    const userDoc = await db.collection("users").doc(decodedToken.uid).get();
    if (!userDoc.exists || userDoc.data().userType !== "ADMIN") {
      return res.status(403).json({ error: "Admin access required" });
    }

    next();
  } catch (error) {
    console.error("Token verification error:", error);
    return res.status(401).json({ error: "Invalid token" });
  }
}

app.get("/", (req, res) => {
  res.send("🚀 Server is running! Try /health or your /api routes.");
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Send approval email
app.post("/api/send-email", async (req, res) => {
  console.log("Email request received");
  console.log("Origin:", req.headers.origin);

  try {
    const { sender, to, subject, htmlContent } = req.body;

    // Validate request
    if (!to || !Array.isArray(to) || to.length === 0) {
      return res.status(400).json({ error: "Invalid 'to' field" });
    }

    if (!subject || !htmlContent) {
      return res.status(400).json({ error: "Missing subject or htmlContent" });
    }

    // CHECK IF API KEY EXISTS
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      console.error("BREVO_API_KEY environment variable not set!");
      return res
        .status(500)
        .json({ error: "Email service not configured - missing API key" });
    }

    // LOG API KEY INFO (first/last 4 chars only for security)
    console.log("API Key present:", apiKey ? "Yes" : "No");
    console.log("API Key length:", apiKey?.length);
    console.log(
      "API Key preview:",
      apiKey
        ? `${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}`
        : "N/A"
    );

    console.log("Sending email to:", to[0].email);
    console.log("Subject:", subject);

    const brevoPayload = {
      sender: sender || {
        name: "Islamove Admin",
        email: "noreply@islamove.com",
      },
      to,
      subject,
      htmlContent,
    };

    console.log("Brevo payload:", JSON.stringify(brevoPayload, null, 2));

    const brevoResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(brevoPayload),
    });

    console.log("Brevo response status:", brevoResponse.status);

    const data = await brevoResponse.json();
    console.log("Brevo response data:", JSON.stringify(data, null, 2));

    if (!brevoResponse.ok) {
      console.error("❌ Brevo API error:", data);
      return res.status(brevoResponse.status).json({
        error: "Brevo API error",
        details: data,
        statusCode: brevoResponse.status,
      });
    }

    console.log("✅ Email sent successfully! Message ID:", data.messageId);

    res.status(200).json({
      success: true,
      messageId: data.messageId,
    });
  } catch (error) {
    console.error("❌ Server error:", error);
    res.status(500).json({
      error: "Failed to send email",
      details: error.message,
    });
  }
});

app.get("/api/test-email", (req, res) => {
  const apiKey = process.env.BREVO_API_KEY;
  res.json({
    message: "✅ Email endpoint is configured!",
    hasBrevoKey: !!apiKey,
    keyLength: apiKey?.length || 0,
    keyPreview: apiKey
      ? `${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}`
      : "Not set",
    endpoint: "/api/send-email",
  });
});

// Update user password endpoint
app.put("/api/users/:userId/password", verifyToken, async (req, res) => {
  const { userId } = req.params;
  const { newPassword, adminId } = req.body;

  try {
    // Validate input
    if (!newPassword || newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    // Prevent changing own password through this endpoint
    if (userId === req.user.uid) {
      return res
        .status(400)
        .json({ error: "Cannot change your own password through admin panel" });
    }

    // Verify adminId matches the authenticated user
    if (adminId !== req.user.uid) {
      return res.status(403).json({ error: "Admin ID mismatch" });
    }

    // Check if user exists in Firestore
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found in database" });
    }

    // Prevent changing other admin passwords
    if (userDoc.data().userType === "ADMIN") {
      return res
        .status(403)
        .json({ error: "Cannot change admin user passwords" });
    }

    // Update password in Firebase Authentication
    await auth.updateUser(userId, {
      password: newPassword,
    });

    console.log(`Updated password for user ${userId} by admin ${adminId}`);

    // Update Firestore (for compatibility - storing plain text passwords is not recommended in production)
    await db.collection("users").doc(userId).update({
      plainTextPassword: newPassword,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      passwordUpdatedBy: adminId,
    });

    res.json({
      success: true,
      message: "Password updated successfully",
      userId: userId,
    });
  } catch (error) {
    console.error("Error updating password:", error);
    res.status(500).json({
      error: "Failed to update password",
      details: error.message,
    });
  }
});

// Delete user endpoint
app.delete("/api/users/:userId", verifyToken, async (req, res) => {
  const { userId } = req.params;

  try {
    // Prevent deleting self
    if (userId === req.user.uid) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }

    // Check if user exists in Firestore
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found in database" });
    }

    // Prevent deleting other admins
    if (userDoc.data().userType === "ADMIN") {
      return res.status(403).json({ error: "Cannot delete admin users" });
    }

    // Delete from Firebase Authentication
    try {
      await auth.deleteUser(userId);
      console.log(`Deleted user ${userId} from Authentication`);
    } catch (authError) {
      if (authError.code === "auth/user-not-found") {
        console.log(
          `User ${userId} not found in Authentication, continuing...`
        );
      } else {
        throw authError;
      }
    }

    // Delete from Firestore using batch
    const batch = db.batch();

    // Delete user document
    batch.delete(db.collection("users").doc(userId));

    // Delete driver document if exists
    batch.delete(db.collection("drivers").doc(userId));

    // Delete rating stats if exists
    batch.delete(db.collection("user_rating_stats").doc(userId));

    await batch.commit();

    // Delete related subcollections (optional - can be done in background)
    // Delete ratings
    const ratingsSnapshot = await db
      .collection("ratings")
      .where("fromUserId", "==", userId)
      .get();

    const ratingsBatch = db.batch();
    ratingsSnapshot.docs.forEach((doc) => {
      ratingsBatch.delete(doc.ref);
    });
    await ratingsBatch.commit();

    // Delete pending ratings
    const pendingRatingsSnapshot = await db
      .collection("pending_ratings")
      .where("fromUserId", "==", userId)
      .get();

    const pendingBatch = db.batch();
    pendingRatingsSnapshot.docs.forEach((doc) => {
      pendingBatch.delete(doc.ref);
    });
    await pendingBatch.commit();

    res.json({
      success: true,
      message: "User deleted successfully",
      userId: userId,
    });
  } catch (error) {
    console.error("Error deleting user:", error);
    res.status(500).json({
      error: "Failed to delete user",
      details: error.message,
    });
  }
});

// Disable user endpoint (soft delete alternative)
app.patch("/api/users/:userId/disable", verifyToken, async (req, res) => {
  const { userId } = req.params;

  try {
    // Disable in Firebase Authentication
    await auth.updateUser(userId, { disabled: true });

    // Update Firestore
    await db.collection("users").doc(userId).update({
      isDeleted: true,
      deletedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedBy: req.user.uid,
      status: "DISABLED",
    });

    res.json({
      success: true,
      message: "User disabled successfully",
    });
  } catch (error) {
    console.error("Error disabling user:", error);
    res.status(500).json({
      error: "Failed to disable user",
      details: error.message,
    });
  }
});

// Get all users endpoint (optional)
app.get("/api/users", verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection("users").get();
    const users = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({ users });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// Update user rating after new rating submission
app.post("/api/ratings/:ratingId/update-stats", async (req, res) => {
  const { ratingId } = req.params;
  const { toUserId, stars, fromUserId } = req.body;

  console.log("=== UPDATE RATING STATS REQUEST ===");
  console.log("Rating ID:", ratingId);
  console.log("To User ID:", toUserId);
  console.log("Stars:", stars);
  console.log("From User ID:", fromUserId);

  try {
    // Validate input
    if (!toUserId || !stars || stars < 1 || stars > 5) {
      console.error("Validation failed:", { toUserId, stars });
      return res.status(400).json({ error: "Invalid rating data" });
    }

    // Verify the rating exists
    console.log("Checking if rating exists...");
    const ratingDoc = await db.collection("ratings").doc(ratingId).get();
    if (!ratingDoc.exists) {
      console.error("Rating not found:", ratingId);
      return res.status(404).json({ error: "Rating not found" });
    }

    const ratingData = ratingDoc.data();
    console.log("Rating data:", ratingData);

    // Verify the request is for the correct user
    if (ratingData.toUserId !== toUserId) {
      console.error(
        "User mismatch. Expected:",
        ratingData.toUserId,
        "Got:",
        toUserId
      );
      return res.status(403).json({ error: "User mismatch" });
    }

    // Get or create user rating stats
    console.log("Fetching user rating stats...");
    const statsRef = db.collection("user_rating_stats").doc(toUserId);
    const statsDoc = await statsRef.get();

    let newStats;
    if (statsDoc.exists) {
      console.log("Existing stats found:", statsDoc.data());
      const currentStats = statsDoc.data();
      const totalRatings = currentStats.totalRatings + 1;
      const newAverage =
        (currentStats.overallRating * currentStats.totalRatings + stars) /
        totalRatings;

      // Update rating breakdown
      const breakdown = currentStats.ratingBreakdown || {
        fiveStars: 0,
        fourStars: 0,
        threeStars: 0,
        twoStars: 0,
        oneStar: 0,
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
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      };
    } else {
      console.log("No existing stats, creating new...");
      // First rating for this user
      const breakdown = {
        fiveStars: stars === 5 ? 1 : 0,
        fourStars: stars === 4 ? 1 : 0,
        threeStars: stars === 3 ? 1 : 0,
        twoStars: stars === 2 ? 1 : 0,
        oneStar: stars === 1 ? 1 : 0,
      };

      newStats = {
        userId: toUserId,
        overallRating: parseFloat(stars.toFixed(1)),
        totalRatings: 1,
        ratingBreakdown: breakdown,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      };
    }

    console.log("New stats to save:", newStats);

    // Update user_rating_stats collection
    await statsRef.set(newStats, { merge: true });
    console.log("✓ user_rating_stats updated");

    // Get user document to check user type
    console.log("Fetching user document...");
    const userDoc = await db.collection("users").doc(toUserId).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      console.log("User type:", userData.userType);

      // Update the rating in users collection based on user type
      if (userData.userType === "DRIVER") {
        console.log("Updating DRIVER rating...");
        const driverData = userData.driverData || {};
        await db
          .collection("users")
          .doc(toUserId)
          .update({
            "driverData.rating": parseFloat(newStats.overallRating.toFixed(1)),
            "driverData.totalRatings": newStats.totalRatings,
            ...driverData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        console.log(`✓ DRIVER rating updated: ${newStats.overallRating}`);
      } else if (userData.userType === "PASSENGER") {
        console.log("Updating PASSENGER rating...");
        await db
          .collection("users")
          .doc(toUserId)
          .update({
            passengerRating: parseFloat(newStats.overallRating.toFixed(1)),
            passengerTotalTrips: newStats.totalRatings,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        console.log(`✓ PASSENGER rating updated: ${newStats.overallRating}`);
      }
    } else {
      console.error("User document not found:", toUserId);
    }

    console.log("=== RATING STATS UPDATE COMPLETE ===\n");

    res.json({
      success: true,
      message: "Rating stats updated successfully",
      stats: newStats,
    });
  } catch (error) {
    console.error("=== ERROR UPDATING RATING STATS ===");
    console.error("Error:", error);
    console.error("Stack:", error.stack);
    res.status(500).json({
      error: "Failed to update rating stats",
      details: error.message,
    });
  }
});

app.post(
  "/api/delete-temp-registration-docs",
  verifyToken,
  async (req, res) => {
    console.log("Delete temp registration docs request");

    try {
      const { tempUserId } = req.body;

      if (!tempUserId) {
        return res.status(400).json({ error: "Temp user ID required" });
      }

      // Get all resources in the temp folder
      const result = await cloudinary.api.resources({
        type: "upload",
        prefix: `registration_temp/${tempUserId}`,
        max_results: 500,
      });

      if (result.resources.length === 0) {
        return res.json({
          success: true,
          message: "No files to delete",
          deletedCount: 0,
        });
      }

      // Delete all files
      const deletePromises = result.resources.map((resource) =>
        cloudinary.uploader.destroy(resource.public_id, {
          resource_type: "image",
          invalidate: true,
        })
      );

      await Promise.all(deletePromises);

      console.log(
        `Deleted ${result.resources.length} temp files for ${tempUserId}`
      );

      res.json({
        success: true,
        message: "Temp files deleted successfully",
        deletedCount: result.resources.length,
      });
    } catch (error) {
      console.error("Error deleting temp files:", error);
      res.status(500).json({
        error: "Failed to delete temp files",
        details: error.message,
      });
    }
  }
);

// Delete specific temp document by type - not used
app.post("/api/delete-specific-temp-doc", verifyToken, async (req, res) => {
  console.log("Delete specific temp document request");

  try {
    const { tempUserId, documentType } = req.body;

    if (!tempUserId || !documentType) {
      return res
        .status(400)
        .json({ error: "Temp user ID and document type required" });
    }

    // Map document types to their Cloudinary naming patterns
    const docTypeMap = {
      passenger_id: "passenger_id",
      license: "license",
      insurance: "insurance",
      vehicle_inspection: "vehicle_inspection",
      vehicle_registration: "vehicle_registration",
    };

    const cloudinaryDocType = docTypeMap[documentType];
    if (!cloudinaryDocType) {
      return res.status(400).json({ error: "Invalid document type" });
    }

    // Get all resources in the temp folder for this user
    const result = await cloudinary.api.resources({
      type: "upload",
      prefix: `registration_temp/${tempUserId}`,
      max_results: 500,
    });

    if (result.resources.length === 0) {
      return res.json({
        success: true,
        message: "No files to delete",
        deletedCount: 0,
      });
    }

    // Filter to only delete files matching this specific document type
    const filesToDelete = result.resources.filter((resource) => {
      const publicId = resource.public_id;
      // Match files that contain the document type in their name
      return publicId.includes(`/${cloudinaryDocType}_`);
    });

    if (filesToDelete.length === 0) {
      return res.json({
        success: true,
        message: `No ${documentType} files found to delete`,
        deletedCount: 0,
      });
    }

    // Delete only the matched files
    const deletePromises = filesToDelete.map((resource) =>
      cloudinary.uploader.destroy(resource.public_id, {
        resource_type: "image",
        invalidate: true,
      })
    );

    await Promise.all(deletePromises);

    console.log(
      `Deleted ${filesToDelete.length} temp file(s) for ${documentType} (user: ${tempUserId})`
    );

    res.json({
      success: true,
      message: `Deleted ${filesToDelete.length} file(s) for ${documentType}`,
      deletedCount: filesToDelete.length,
    });
  } catch (error) {
    console.error("Error deleting specific temp file:", error);
    res.status(500).json({
      error: "Failed to delete specific temp file",
      details: error.message,
    });
  }
});

app.delete("/api/delete-image", authenticateToken, async (req, res) => {
  try {
    const { publicId } = req.body;
    const userId = req.user.uid;

    // Verify the publicId belongs to this user for security
    if (!publicId.includes(`profile_pictures/${userId}`)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Delete from Cloudinary
    const result = await cloudinary.uploader.destroy(publicId, {
      invalidate: true, // This invalidates the CDN cache
    });

    console.log(`Deleted image: ${publicId}`, result);
    res.json({ success: true, result });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ===== KEEP RENDER AWAKE =====
if (process.env.NODE_ENV === "production") {
  const RENDER_URL = process.env.RENDER_BASE_URL;

  console.log("Starting keep-alive service...");

  setInterval(async () => {
    try {
      const response = await fetch(`${RENDER_URL}/health`);
      const timestamp = new Date().toLocaleTimeString();
      console.log(`[${timestamp}] Keep-alive ping: ${response.status}`);
    } catch (error) {
      console.log("Keep-alive ping failed:", error.message);
    }
  }, 14 * 60 * 1000); // Ping every 14 minutes
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Email endpoint: http://localhost:${PORT}/api/send-email`);
  console.log(`CORS enabled for:`, allowedOrigins);
});
