require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Middleware for logging requests and responses
app.use((req, res, next) => {
    const start = Date.now();
    
    // Log request
    console.log('\n=== Incoming Request ===');
    console.log(`${new Date().toISOString()}`);
    console.log(`${req.method} ${req.url}`);
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    
    // Capture response
    const oldSend = res.send;
    res.send = function(data) {
        // Log response
        console.log('\n=== Outgoing Response ===');
        console.log(`${new Date().toISOString()}`);
        console.log(`Status: ${res.statusCode}`);
        console.log('Response:', data);
        console.log(`Time taken: ${Date.now() - start}ms\n`);
        
        oldSend.apply(res, arguments);
    };
    
    next();
});

app.use(cors());
app.use(express.static('public'));

// Initialize SQLite database
const db = new sqlite3.Database('chat.db', (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

// Create database tables
function initializeDatabase() {
    db.serialize(() => {
        // Create conversations table
        db.run(`
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create messages table
        db.run(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT,
                role TEXT,
                content TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                message_type TEXT DEFAULT 'chat',
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            )
        `);
    });
}

const token = process.env.GITHUB_TOKEN;
const endpoint = "https://models.inference.ai.azure.com";

// Available models
const AVAILABLE_MODELS = {
    'o1': 'o1',
    'gpt-4o-mini': 'gpt-4o-mini',
    'o1-preview': 'o1-preview',
    'gpt-4o': 'gpt-4o'
};

let currentModel = AVAILABLE_MODELS['gpt-4o']; // Default model

const client = new OpenAI({ baseURL: endpoint, apiKey: token });

// Get all conversations
app.get('/api/conversations', (req, res) => {
    db.all('SELECT * FROM conversations ORDER BY created_at DESC', [], (err, rows) => {
        if (err) {
            console.error('Error fetching conversations:', err);
            res.status(500).json({ error: 'Failed to fetch conversations' });
            return;
        }
        res.json(rows);
    });
});

// Get messages for a specific conversation
app.get('/api/conversations/:id/messages', (req, res) => {
    const { id } = req.params;
    db.all(
        'SELECT * FROM messages WHERE conversation_id = ? AND message_type = ? ORDER BY created_at ASC', 
        [id, 'chat'], 
        (err, rows) => {
            if (err) {
                console.error('Error fetching messages:', err);
                res.status(500).json({ error: 'Failed to fetch messages' });
                return;
            }
            res.json(rows);
        }
    );
});

// Get debug messages for a specific conversation
app.get('/api/conversations/:id/debug', (req, res) => {
    const { id } = req.params;
    db.all(
        'SELECT * FROM messages WHERE conversation_id = ? AND message_type = ? ORDER BY created_at ASC', 
        [id, 'debug'], 
        (err, rows) => {
            if (err) {
                console.error('Error fetching debug messages:', err);
                res.status(500).json({ error: 'Failed to fetch debug messages' });
                return;
            }
            res.json(rows);
        }
    );
});

// Create new conversation
app.post('/api/conversations', (req, res) => {
    const id = uuidv4();
    const { title } = req.body;
    
    db.run('INSERT INTO conversations (id, title) VALUES (?, ?)', [id, title], (err) => {
        if (err) {
            console.error('Error creating conversation:', err);
            res.status(500).json({ error: 'Failed to create conversation' });
            return;
        }
        res.json({ id, title });
    });
});

app.post('/api/chat', express.json({ limit: '50mb' }), async (req, res) => {
    try {
        const { message, conversationId, files } = req.body;
        
        // Prepare messages array for OpenAI
        const messages = [
            { 
                role: "system", 
                content: `You are an advanced AI assistant specialized in programming and mathematics. Your capabilities include:

1. Programming:
   - Code analysis and debugging
   - Algorithm optimization
   - Best practices and design patterns
   - Multiple programming languages expertise
   - Code review and suggestions

2. Mathematics:
   - Advanced mathematical problem-solving
   - Step-by-step solution explanations
   - Mathematical proofs
   - Statistical analysis
   - Numerical methods and computations

3. Image Analysis:
   - Code screenshot analysis
   - Mathematical equation recognition
   - Diagram and flowchart interpretation
   - Whiteboard content analysis
   - Mathematical graph interpretation

Provide detailed, accurate solutions with explanations. When dealing with code, include comments and best practices. For mathematical problems, show step-by-step solutions with clear reasoning.`
            }
        ];

        // Add files to the message if present
        if (files && files.length > 0) {
            const imageMessages = files.map(file => ({
                type: "image_url",
                image_url: { url: file.data }
            }));

            messages.push({
                role: "user",
                content: [
                    { type: "text", text: message || "What do you see in these images?" },
                    ...imageMessages
                ]
            });
        } else {
            messages.push({
                role: "user",
                content: message
            });
        }

        // Create OpenAI client
        const openaiClient = new OpenAI({
            baseURL: endpoint,
            apiKey: token
        });

        // Get OpenAI response
        const completion = await openaiClient.chat.completions.create({
            model: currentModel,
            messages: messages,
            max_tokens: 1000
        });

        const aiResponse = completion.choices[0].message;
        const messageId = uuidv4();
        const aiMessageId = uuidv4();

        // Save user message
        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
                [messageId, conversationId, 'user', message],
                (err) => err ? reject(err) : resolve()
            );
        });

        // Save AI response
        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
                [aiMessageId, conversationId, 'assistant', aiResponse.content],
                (err) => err ? reject(err) : resolve()
            );
        });

        res.json({
            message: aiResponse.content,
            conversationId: conversationId
        });
    } catch (error) {
        if (error.status === 429) {
            // Rate limit error
            const waitTimeSeconds = parseInt(error.headers?.['retry-after']) || 0;
            const waitTimeMinutes = Math.ceil(waitTimeSeconds / 60);
            const waitTimeHours = Math.floor(waitTimeMinutes / 60);
            
            let waitMessage = 'Rate limit exceeded. ';
            if (waitTimeHours > 0) {
                waitMessage += `Please wait approximately ${waitTimeHours} hours and ${waitTimeMinutes % 60} minutes before trying again.`;
            } else {
                waitMessage += `Please wait approximately ${waitTimeMinutes} minutes before trying again.`;
            }
            
            res.status(429).json({
                error: waitMessage,
                retryAfter: waitTimeSeconds,
                code: 'RATE_LIMIT_EXCEEDED'
            });
        } else if (error.status === 413) {
            res.status(413).json({
                error: 'File size is too large. Maximum allowed size is 1MB per file.',
                code: 'PAYLOAD_TOO_LARGE'
            });
        } else if (error.status === 400) {
            res.status(400).json({
                error: 'Invalid request. Please check your inputs.',
                code: 'BAD_REQUEST'
            });
        } else {
            throw error; // Re-throw other errors to be caught by outer catch block
        }
    }
});

// Add debug message endpoint
app.post('/api/chat/debug', async (req, res) => {
    try {
        const { message, conversationId } = req.body;
        
        // Save debug message
        const debugId = uuidv4();
        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO messages (id, conversation_id, role, content, message_type) VALUES (?, ?, ?, ?, ?)',
                [debugId, conversationId, 'system', message, 'debug'],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error saving debug message:', error);
        res.status(500).json({ error: 'Failed to save debug message' });
    }
});

// Get available models
app.get('/api/models', (req, res) => {
    res.json(Object.keys(AVAILABLE_MODELS));
});

// Set model
app.post('/api/models/select', (req, res) => {
    const { model } = req.body;
    if (AVAILABLE_MODELS[model]) {
        currentModel = AVAILABLE_MODELS[model];
        res.json({ success: true, currentModel });
    } else {
        res.status(400).json({ error: 'Invalid model selection' });
    }
});

// Delete conversation
app.delete('/api/conversations/:id', (req, res) => {
    const { id } = req.params;
    
    db.serialize(() => {
        db.run('DELETE FROM messages WHERE conversation_id = ?', [id]);
        db.run('DELETE FROM conversations WHERE id = ?', [id], (err) => {
            if (err) {
                console.error('Error deleting conversation:', err);
                res.status(500).json({ error: 'Failed to delete conversation' });
                return;
            }
            res.json({ success: true });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n=== Server Started ===`);
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('===================\n');
});
