const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// In-memory storage for games
const games = {};

// Function to create a clean, sendable version of the game state
function getSanitizedGameState(game) {
    if (!game) return null;
    // This new object only contains data safe to send as JSON
    return {
        secretWord: game.secretWord, // Note: only send this at the end of the game
        guessesLeft: game.guessesLeft,
        currentPlayer: game.currentPlayer,
        messages: game.messages,
        lastQuestion: game.lastQuestion,
        status: game.status,
        winner: game.winner,
    };
}


// Function to generate a unique 5-character game ID
function generateGameId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    do {
        result = '';
        for (let i = 0; i < 5; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (games[result]); // Ensure the ID is unique
    return result;
}

wss.on('connection', (ws) => {
    // Each connection gets a unique ID
    ws.id = Date.now(); 

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        const { type, payload } = data;

        switch (type) {
            case 'createGame': {
                const gameId = generateGameId();
                games[gameId] = {
                    player1: ws,
                    player2: null,
                    secretWord: payload.secretWord,
                    guessesLeft: 20,
                    currentPlayer: 1, // Player 1 waits
                    messages: [],
                    lastQuestion: '',
                    status: 'waiting',
                    winner: null
                };
                ws.gameId = gameId; // Associate this connection with the game
                
                // Send confirmation back to Player 1
                ws.send(JSON.stringify({
                    type: 'gameCreated',
                    payload: { gameId: gameId, gameState: getSanitizedGameState(games[gameId]) }
                }));
                break;
            }

            case 'joinGame': {
                const { gameId } = payload;
                const game = games[gameId];

                if (game) {
                    if (game.player2 && game.player2.readyState === 1) {
                        ws.send(JSON.stringify({ type: 'error', payload: { message: 'This game is already full.' } }));
                        return;
                    }
                    
                    game.player2 = ws;
                    game.status = 'active';
                    game.currentPlayer = 2; // FIX: Give the turn to Player 2 immediately
                    ws.gameId = gameId;

                    // Notify both players that the game has started
                    const gameState = getSanitizedGameState(game);
                    const message = { type: 'gameUpdate', payload: gameState };
                    if (game.player1) game.player1.send(JSON.stringify(message));
                    if (game.player2) game.player2.send(JSON.stringify(message));
                } else {
                    ws.send(JSON.stringify({ type: 'error', payload: { message: 'Game not found.' } }));
                }
                break;
            }

            case 'askQuestion': {
                const game = games[ws.gameId];
                if (game && game.currentPlayer === 2) {
                    game.lastQuestion = payload.question;
                    game.messages.push({ type: 'question', text: payload.question });
                    game.currentPlayer = 1; // Switch to Player 1 to answer

                    const gameState = getSanitizedGameState(game);
                    const message = { type: 'gameUpdate', payload: gameState };
                    if (game.player1) game.player1.send(JSON.stringify(message));
                    if (game.player2) game.player2.send(JSON.stringify(message));
                }
                break;
            }

            case 'sendAnswer': {
                const game = games[ws.gameId];
                if (game && game.currentPlayer === 1) {
                    game.guessesLeft--;
                    const answerText = `${game.lastQuestion}\n> ${payload.answer}`;
                    game.messages.push({ type: 'answer', text: answerText });
                    
                    if (game.guessesLeft <= 0) {
                        game.status = 'finished';
                        game.winner = 1; // Player 1 wins
                    } else {
                        game.currentPlayer = 2; // Switch back to Player 2
                    }

                    const gameState = getSanitizedGameState(game);
                    // At the end of the game, reveal the secret word
                    if (gameState.status === 'finished') {
                        gameState.secretWord = game.secretWord;
                    } else {
                        delete gameState.secretWord; // Don't send the secret word during the game
                    }
                    const message = { type: 'gameUpdate', payload: gameState };
                    if (game.player1) game.player1.send(JSON.stringify(message));
                    if (game.player2) game.player2.send(JSON.stringify(message));
                }
                break;
            }
            
            case 'endGame': {
                 const game = games[ws.gameId];
                 if (game) {
                    game.status = 'finished';
                    game.winner = payload.winner;
                    
                    const gameState = getSanitizedGameState(game);
                    gameState.secretWord = game.secretWord; // Reveal the word
                    const message = { type: 'gameUpdate', payload: gameState };
                    if (game.player1) game.player1.send(JSON.stringify(message));
                    if (game.player2) game.player2.send(JSON.stringify(message));
                 }
                 break;
            }
        }
    });

    ws.on('close', () => {
        // Handle player disconnection
        const game = games[ws.gameId];
        if (game) {
            const isPlayer1 = game.player1 && game.player1.id === ws.id;
            
            // Mark the game as finished and notify the other player
            game.status = 'finished';
            game.winner = isPlayer1 ? 2 : 1; // The other player wins
            
            const otherPlayer = isPlayer1 ? game.player2 : game.player1;
            if (otherPlayer && otherPlayer.readyState === 1) {
                 const gameState = getSanitizedGameState(game);
                 gameState.secretWord = game.secretWord;
                 otherPlayer.send(JSON.stringify({ 
                    type: 'opponentDisconnected', 
                    payload: { message: 'Your opponent has disconnected. You win!', gameState: gameState }
                }));
            }
            // Clean up the game room
            delete games[ws.gameId];
        }
    });
});

server.listen(8080, () => {
    console.log('Server is listening on port 8080');
});

