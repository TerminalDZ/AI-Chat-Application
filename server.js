require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const multer = require('multer');
const fs = require('fs').promises;

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Data file paths
const CONVERSATIONS_FILE = path.join(__dirname, 'data', 'conversations.json');
const MESSAGES_FILE = path.join(__dirname, 'data', 'messages.json');
const DEBUG_MESSAGES_FILE = path.join(__dirname, 'data', 'debug_messages.json');

// Ensure data directory and files exist
async function ensureDataFiles() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
        
        // Check and create conversations.json if not exists
        try {
            await fs.access(CONVERSATIONS_FILE);
        } catch {
            await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify({ conversations: [] }));
        }
        
        // Check and create messages.json if not exists
        try {
            await fs.access(MESSAGES_FILE);
        } catch {
            await fs.writeFile(MESSAGES_FILE, JSON.stringify({ messages: [] }));
        }
        
        // Check and create debug_messages.json if not exists
        try {
            await fs.access(DEBUG_MESSAGES_FILE);
        } catch {
            await fs.writeFile(DEBUG_MESSAGES_FILE, JSON.stringify({ messages: [] }));
        }
    } catch (error) {
        console.error('Error ensuring data files:', error);
    }
}

// Data management functions
async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
        return null;
    }
}

async function writeJsonFile(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`Error writing ${filePath}:`, error);
    }
}

// Initialize data files
ensureDataFiles();

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
app.get('/api/conversations', async (req, res) => {
    try {
        const data = await readJsonFile(CONVERSATIONS_FILE);
        res.json(data.conversations);
    } catch (error) {
        console.error('Error getting conversations:', error);
        res.status(500).json({ error: 'Failed to get conversations' });
    }
});

// Get messages for a specific conversation
app.get('/api/conversations/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await readJsonFile(MESSAGES_FILE);
        const conversationMessages = data.messages.filter(msg => msg.conversation_id === id && msg.message_type === 'chat');
        res.json(conversationMessages);
    } catch (error) {
        console.error('Error getting messages:', error);
        res.status(500).json({ error: 'Failed to get messages' });
    }
});

// Get debug messages for a specific conversation
app.get('/api/conversations/:id/debug', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await readJsonFile(DEBUG_MESSAGES_FILE);
        const conversationMessages = data.messages.filter(msg => msg.conversation_id === id);
        res.json(conversationMessages);
    } catch (error) {
        console.error('Error getting debug messages:', error);
        res.status(500).json({ error: 'Failed to get debug messages' });
    }
});

// Create new conversation
app.post('/api/conversations', async (req, res) => {
    try {
        const data = await readJsonFile(CONVERSATIONS_FILE);
        const newConversation = {
            id: uuidv4(),
            title: req.body.title,
            created_at: new Date().toISOString()
        };
        data.conversations.push(newConversation);
        await writeJsonFile(CONVERSATIONS_FILE, data);
        res.json(newConversation);
    } catch (error) {
        console.error('Error creating conversation:', error);
        res.status(500).json({ error: 'Failed to create conversation' });
    }
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
        const messagesData = await readJsonFile(MESSAGES_FILE);
        messagesData.messages.push({
            id: messageId,
            conversation_id: conversationId,
            role: 'user',
            content: message,
            created_at: new Date().toISOString(),
            message_type: 'chat'
        });
        await writeJsonFile(MESSAGES_FILE, messagesData);

        // Save AI response
        messagesData.messages.push({
            id: aiMessageId,
            conversation_id: conversationId,
            role: 'assistant',
            content: aiResponse.content,
            created_at: new Date().toISOString(),
            message_type: 'chat'
        });
        await writeJsonFile(MESSAGES_FILE, messagesData);

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
        const debugMessagesData = await readJsonFile(DEBUG_MESSAGES_FILE);
        debugMessagesData.messages.push({
            id: uuidv4(),
            conversation_id: conversationId,
            role: 'system',
            content: message,
            created_at: new Date().toISOString()
        });
        await writeJsonFile(DEBUG_MESSAGES_FILE, debugMessagesData);
        
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
app.delete('/api/conversations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Remove conversation
        const conversationsData = await readJsonFile(CONVERSATIONS_FILE);
        conversationsData.conversations = conversationsData.conversations.filter(conv => conv.id !== id);
        await writeJsonFile(CONVERSATIONS_FILE, conversationsData);
        
        // Remove associated messages
        const messagesData = await readJsonFile(MESSAGES_FILE);
        messagesData.messages = messagesData.messages.filter(msg => msg.conversation_id !== id);
        await writeJsonFile(MESSAGES_FILE, messagesData);
        
        // Remove associated debug messages
        const debugMessagesData = await readJsonFile(DEBUG_MESSAGES_FILE);
        debugMessagesData.messages = debugMessagesData.messages.filter(msg => msg.conversation_id !== id);
        await writeJsonFile(DEBUG_MESSAGES_FILE, debugMessagesData);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting conversation:', error);
        res.status(500).json({ error: 'Failed to delete conversation' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n=== Server Started ===`);
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('===================\n');
});
