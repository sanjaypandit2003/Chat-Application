// server.js
// Real-time chat backend with:
//  - Express + Socket.IO
//  - Firestore "messages" collection (chat history)
//  - Firestore "users" collection (username + password for signup/login)

const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");
const admin = require("firebase-admin");

// ---------------- FIREBASE ADMIN SETUP ----------------
// Make sure serviceAccountKey.json is in the SAME folder as this file.
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messagesCol = db.collection("messages");
const usersCol = db.collection("users");

// ---------------- EXPRESS + SOCKET.IO ----------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// =====================================================
//  AUTH ROUTES  (SIGNUP + LOGIN)
// =====================================================

// POST /api/signup  { username, password }
app.post("/api/signup", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "Username and password are required." });
    }

    const uname = String(username).trim();
    const pwd = String(password).trim();

    if (!uname || !pwd) {
      return res
        .status(400)
        .json({ ok: false, error: "Username and password cannot be empty." });
    }

    // Check if already registered
    const userDoc = await usersCol.doc(uname).get();
    if (userDoc.exists) {
      return res
        .status(409)
        .json({ ok: false, error: "Username already registered. Please login." });
    }

    // NOTE: password is plain text ONLY for demo!
    await usersCol.doc(uname).set({
      username: uname,
      password: pwd,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, username: uname });
  } catch (err) {
    console.error("Signup error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Internal server error during signup." });
  }
});

// POST /api/login  { username, password }
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "Username and password are required." });
    }

    const uname = String(username).trim();
    const pwd = String(password).trim();

    const userDoc = await usersCol.doc(uname).get();
    if (!userDoc.exists) {
      return res
        .status(404)
        .json({ ok: false, error: "No account found. Please sign up first." });
    }

    const data = userDoc.data();
    if (data.password !== pwd) {
      return res
        .status(401)
        .json({ ok: false, error: "Incorrect password." });
    }

    return res.json({ ok: true, username: uname });
  } catch (err) {
    console.error("Login error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Internal server error during login." });
  }
});

// =====================================================
//  GET CHAT HISTORY FOR A ROOM
// =====================================================
app.get("/api/messages/:room", async (req, res) => {
  try {
    const room = req.params.room || "general";

    const snap = await messagesCol.where("room", "==", room).get();

    let msgs = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        room: d.room,
        senderName: d.senderName,
        text: d.text,
        attachments: d.attachments || null,
        createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : null,
      };
    });

    msgs.sort((a, b) => {
      if (!a.createdAt && !b.createdAt) return 0;
      if (!a.createdAt) return -1;
      if (!b.createdAt) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });

    res.json(msgs);
  } catch (err) {
    console.error("Error fetching messages:", err);
    res.status(500).json({ error: "Server error while loading messages." });
  }
});

// =====================================================
//  SOCKET.IO REAL-TIME CHAT
// =====================================================

const onlineUsers = new Set();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // user joins a room
  socket.on("join", async ({ username, room }, callback) => {
    try {
      const uname = (username || "").trim();
      const r = (room || "general").trim();

      if (!uname || !r) {
        if (callback)
          callback({ ok: false, error: "Missing username or room." });
        return;
      }

      if (onlineUsers.has(uname) && socket.username !== uname) {
        if (callback)
          callback({
            ok: false,
            error: "Username already in use. Choose another.",
          });
        return;
      }

      socket.username = uname;
      socket.room = r;

      socket.join(r);
      onlineUsers.add(uname);

      const systemMsg = {
        room: r,
        senderName: "system",
        text: `${uname} joined the room`,
        createdAt: new Date().toISOString(),
      };
      io.to(r).emit("system-message", systemMsg);

      if (callback) callback({ ok: true });
    } catch (err) {
      console.error("Join error:", err);
      if (callback) callback({ ok: false, error: "Server error on join." });
    }
  });

  // chat message with attachments support
  socket.on("chat-message", async ({ room, username, text, attachments }) => {
    try {
      const r = (room || socket.room || "general").trim();
      const uname = (username || socket.username || "Anonymous").trim();
      const msgText = (text || "").trim();
      
      if (!msgText && (!attachments || attachments.length === 0)) return;

      const createdAt = new Date().toISOString();
      
      // Prepare attachments for emission (keep data for current session)
      const attachmentsToEmit = attachments || [];
      
      // For storage, we only keep metadata (not base64 data to save space)
      const attachmentMetadata = (attachments || []).map(att => ({
        name: att.name,
        type: att.type,
        size: att.size,
      }));

      const msg = { 
        room: r, 
        senderName: uname, 
        text: msgText, 
        createdAt,
        attachments: attachmentsToEmit.length > 0 ? attachmentsToEmit : null
      };

      io.to(r).emit("chat-message", msg);

      // Store in Firestore (with metadata only, not full base64)
      await messagesCol.add({
        room: r,
        senderName: uname,
        text: msgText,
        attachments: attachmentMetadata.length > 0 ? attachmentMetadata : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error("chat-message error:", err);
    }
  });

  socket.on("disconnect", () => {
    const uname = socket.username;
    const r = socket.room;
    if (uname && onlineUsers.has(uname)) {
      onlineUsers.delete(uname);
      if (r) {
        const systemMsg = {
          room: r,
          senderName: "system",
          text: `${uname} left the room`,
          createdAt: new Date().toISOString(),
        };
        io.to(r).emit("system-message", systemMsg);
      }
    }
    console.log("User disconnected:", socket.id);
  });
});

// =====================================================
//  START SERVER
// =====================================================
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
