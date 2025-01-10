require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const multer = require('multer');
const speedInsights = require("@vercel/speed-insights/next");

// Create Express app
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));




// In-memory storage
const CONVERSATIONS = [];
const MESSAGES = [];
const DEBUG_MESSAGES = [];

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
        res.json(CONVERSATIONS);
    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({ error: 'Failed to fetch conversations' });
    }
});

// Get messages for a specific conversation
app.get('/api/conversations/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const conversationMessages = MESSAGES.filter(msg => msg.conversationId === id);
        res.json(conversationMessages);
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// Get debug messages for a specific conversation
app.get('/api/conversations/:id/debug', async (req, res) => {
    try {
        const { id } = req.params;
        const conversationMessages = DEBUG_MESSAGES.filter(msg => msg.conversationId === id);
        res.json({ messages: conversationMessages });
    } catch (error) {
        console.error('Error fetching debug messages:', error);
        res.status(500).json({ error: 'Failed to fetch debug messages' });
    }
});

// Create new conversation
app.post('/api/conversations', async (req, res) => {
    try {
        const conversationId = uuidv4();
        const newConversation = {
            id: conversationId,
            created_at: new Date().toISOString()
        };
        CONVERSATIONS.push(newConversation);
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
        MESSAGES.push({
            id: messageId,
            conversationId: conversationId,
            role: 'user',
            content: message,
            created_at: new Date().toISOString(),
            message_type: 'chat'
        });

        // Save AI response
        MESSAGES.push({
            id: aiMessageId,
            conversationId: conversationId,
            role: 'assistant',
            content: aiResponse.content,
            created_at: new Date().toISOString(),
            message_type: 'chat'
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
        DEBUG_MESSAGES.push({
            id: uuidv4(),
            conversationId: conversationId,
            role: 'system',
            content: message,
            created_at: new Date().toISOString()
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
app.delete('/api/conversations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Remove conversation
        const conversationIndex = CONVERSATIONS.findIndex(conv => conv.id === id);
        if (conversationIndex !== -1) {
            CONVERSATIONS.splice(conversationIndex, 1);
        }
        
        // Remove associated messages
        const messageIndices = [];
        MESSAGES.forEach((msg, index) => {
            if (msg.conversationId === id) {
                messageIndices.unshift(index);
            }
        });
        messageIndices.forEach(index => MESSAGES.splice(index, 1));
        
        // Remove associated debug messages
        const debugMessageIndices = [];
        DEBUG_MESSAGES.forEach((msg, index) => {
            if (msg.conversationId === id) {
                debugMessageIndices.unshift(index);
            }
        });
        debugMessageIndices.forEach(index => DEBUG_MESSAGES.splice(index, 1));
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting conversation:', error);
        res.status(500).json({ error: 'Failed to delete conversation' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n=== Server Started ===`);
    console.log(`Server running on port ${PORT}`);
    console.log('===================\n');
});

// Speed Insights
speedInsights(app, {
    version: 'v1'
});
