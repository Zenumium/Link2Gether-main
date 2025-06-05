import React, { useEffect, useState, useRef, useCallback } from 'react';

const WS_URL = 'ws://localhost:8080/ws';
const RECONNECT_INTERVAL_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 10;
const EXPONENTIAL_BACKOFF_FACTOR = 1.5;
const SYNC_REQUEST_DELAY = 500;
const DUPLICATE_CHECK_WINDOW = 3000;
const MAX_DUPLICATE_CHECK_MESSAGES = 10;

function OnlineUsersSection({ onlineUsers }) {
  return (
    <div className="mt-6 bg-black bg-opacity-40 backdrop-blur-md rounded-3xl shadow-2xl p-4 border border-pink-500 fixed bottom-4 left-4 right-4 z-10">
      <h3 className="text-pink-300 text-xl font-bold drop-shadow-[0_0_5px_rgba(255,105,180,0.7)] mb-2">
        Online Users
      </h3>
      <div className="text-pink-400 text-sm font-semibold">
        ({onlineUsers.length}):{' '}
        {onlineUsers.length === 0 ? (
          'None'
        ) : (
          onlineUsers.map((user, index) => (
            <span key={user.username} className="mr-2 flex items-center">
              {user.username} ({(user.watchHours ?? 0).toFixed(1)}h)
              {index === 0 && (
                <span className="ml-1 px-1.5 py-0.5 text-xs font-bold text-yellow-400 bg-pink-700 rounded-full shadow-[0_0_5px_rgba(255,105,180,0.7)]">
                  Host
                </span>
              )}
              {index < onlineUsers.length - 1 ? ', ' : ''}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

export default function ChatRoom({ username, videoState, onVideoStateChange }) {
  const [messages, setMessages] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]); // New state for typing users

  const [watchHours, setWatchHours] = useState(() => {
    // Initialize from localStorage if available
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('watchHours');
      return saved ? parseFloat(saved) : 0;
    }
    return 0;
  });
  const [input, setInput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [syncStatus, setSyncStatus] = useState('waiting');

  const messagesEndRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const isUnmountingRef = useRef(false);
  const lastSentMessageRef = useRef('');
  const messageIdCounter = useRef(0);
  const videoStateRef = useRef(videoState);
  const syncTimeoutRef = useRef(null);
  const pendingVideoStateRef = useRef(null);
  const lastVideoStateSentRef = useRef(null);
  const onVideoStateChangeRef = useRef(onVideoStateChange);
  const connectionInitializedRef = useRef(false);
  
  // Update refs when props change
  useEffect(() => {
    videoStateRef.current = videoState;
  }, [videoState]);

  useEffect(() => {
    onVideoStateChangeRef.current = onVideoStateChange;
  }, [onVideoStateChange]);

  // Increment watchHours every second if video is playing
  useEffect(() => {
    let intervalId;

    if (videoState?.isYoutubePlaying) {
      intervalId = setInterval(() => {
        setWatchHours((prev) => {
          const newVal = prev + 1 / 3600; // increment by 1 second in hours
          if (typeof window !== 'undefined') {
            localStorage.setItem('watchHours', newVal.toString());
          }
          return newVal;
        });
      }, 1000);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [videoState?.isYoutubePlaying]);

  // Send watchHours update to other users when watchHours changes (throttled to every 5 seconds)
  useEffect(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const interval = 8000; // 5 seconds
    let lastSent = 0;

    const sendThrottled = () => {
      const now = Date.now();
      if (now - lastSent >= interval) {
        const watchHoursMessage = {
          type: 'watchHours',
          watchHours,
        };
        try {
          wsRef.current.send(JSON.stringify(watchHoursMessage));
          // console.log(`[${username}] Sent watchHours update: ${watchHours.toFixed(2)}`);
          lastSent = now;
        } catch (err) {
          console.error(`[${username}] Error sending watchHours update:`, err);
        }
      }
    };

    sendThrottled();

    const intervalId = setInterval(sendThrottled, interval);

    return () => clearInterval(intervalId);
  }, [watchHours, username]);

  // Send typing notification when user types (debounced)
  useEffect(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!input) return;

    const typingMessage = {
      type: 'typing',
      sender: username,
    };

    try {
      wsRef.current.send(JSON.stringify(typingMessage));
    } catch (err) {
      console.error(`[${username}] Error sending typing message:`, err);
    }
  }, [input, username]);

  // Update onlineUsers with watchHours for current user
  useEffect(() => {
    setOnlineUsers((prevUsers) => {
      // Map previous users to keep watchHours if available
      const updatedUsers = prevUsers.map((user) => {
        if (user.username === username) {
          return { ...user, watchHours };
        }
        return user;
      });

      // If current user not in list, add them
      if (!updatedUsers.some((user) => user.username === username)) {
        updatedUsers.push({ username, watchHours });
      }

      // For other users, if they don't have watchHours, set to 0
      return updatedUsers.map((user) => ({
        username: user.username,
        watchHours: user.watchHours || 0,
      }));
    });
  }, [watchHours, username]);

  // Update onlineUsers when presence message received
  const handlePresenceUpdate = (users) => {
    setOnlineUsers((prevUsers) => {
      // Keep watchHours for existing users, set 0 for new users except current user
      const newUsers = users.map((user) => {
        const existingUser = prevUsers.find((u) => u.username === user);
        if (existingUser) {
          return existingUser;
        }
        if (user === username) {
          return { username: user, watchHours };
        }
        return { username: user, watchHours: 0 };
      });
      return newUsers;
    });
  };

  // Handle incoming watchHours messages from other users
  const handleWatchHoursUpdate = useCallback((sender, watchHoursValue) => {
    setOnlineUsers((prevUsers) => {
      return prevUsers.map((user) => {
        if (user.username === sender) {
          return { ...user, watchHours: watchHoursValue };
        }
        return user;
      });
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const areVideoStatesEqual = useCallback((state1, state2) => {
    if (!state1 && !state2) return true;
    if (!state1 || !state2) return false;
    
    return (
      state1.youtubeUrl === state2.youtubeUrl &&
      state1.isYoutubePlaying === state2.isYoutubePlaying &&
      Math.abs((state1.currentTime || 0) - (state2.currentTime || 0)) < 2 &&
      JSON.stringify(state1.youtubeQueue || []) === JSON.stringify(state2.youtubeQueue || []) &&
      state1.currentIndex === state2.currentIndex
    );
  }, []);

  const sendVideoState = useCallback((state, force = false) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      pendingVideoStateRef.current = state;
      return;
    }

    if (!state) return;

    if (!force && lastVideoStateSentRef.current && areVideoStatesEqual(state, lastVideoStateSentRef.current)) {
      return;
    }

    const videoMessage = {
      type: 'video',
      videoUrl: state.youtubeUrl || '',
      playbackState: state.isYoutubePlaying ? 'play' : 'pause',
      currentTime: state.currentTime || 0,
      queue: state.youtubeQueue || [],
      index: state.currentIndex || 0,
      timestamp: Date.now()
    };

    try {
      wsRef.current.send(JSON.stringify(videoMessage));
      lastVideoStateSentRef.current = state;
      console.log(`[${username}] Video state sent:`, videoMessage);
    } catch (err) {
      console.error(`[${username}] Error sending video state:`, err);
    }
  }, [username, areVideoStatesEqual]);

  const requestVideoSync = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    setSyncStatus('syncing');
    
    try {
      wsRef.current.send(JSON.stringify({ type: 'sync', timestamp: Date.now() }));
      console.log(`[${username}] Sent video state sync request.`);
      
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
      
      syncTimeoutRef.current = setTimeout(() => {
        console.warn(`[${username}] Sync request timed out`);
        setSyncStatus('waiting');
      }, 5000);
      
    } catch (err) {
      console.error(`[${username}] Error requesting sync:`, err);
      setSyncStatus('waiting');
    }
  }, [username]);

  const handleWebSocketMessage = useCallback((event) => {
    try {
      const msg = JSON.parse(event.data);
      // console.log(`[${username}] Received message:`, msg);

      if (msg.type === 'message') {
        const messageWithId = {
          ...msg,
          id: `${msg.sender}-${msg.timestamp || Date.now()}-${messageIdCounter.current++}`,
          timestamp: msg.timestamp || Date.now()
        };

        setMessages(prev => {
          const isDuplicate = prev.slice(-MAX_DUPLICATE_CHECK_MESSAGES).some(prevMsg => 
            prevMsg.sender === msg.sender && 
            prevMsg.content === msg.content &&
            Math.abs(prevMsg.timestamp - messageWithId.timestamp) < DUPLICATE_CHECK_WINDOW
          );
          
          if (isDuplicate) {
            console.log(`[${username}] Skipping duplicate message:`, msg.content);
            return prev;
          }
          
          return [...prev, messageWithId];
        });
      }

      else if (msg.type === 'presence') {
        console.log(`[${username}] Updated online users:`, msg.users);
        handlePresenceUpdate(Array.isArray(msg.users) ? [...new Set(msg.users)] : []);
      }

      else if (msg.type === 'typing' && msg.sender !== username) {
        // Add sender to typingUsers state and remove after timeout
        setTypingUsers((prev) => {
          if (prev.includes(msg.sender)) return prev;
          return [...prev, msg.sender];
        });

        // Remove typing user after 3 seconds of no typing message
        setTimeout(() => {
          setTypingUsers((prev) => prev.filter(user => user !== msg.sender));
        }, 3000);
      }

      else if (msg.type === 'video' && msg.sender !== username) {
        const newVideoState = {
          videoUrl: msg.videoUrl || '',
          playbackState: msg.playbackState,
          currentTime: msg.currentTime || 0,
          queue: msg.queue || [],
          index: msg.index || 0,
        };

        const currentState = videoStateRef.current;
        if (!areVideoStatesEqual(currentState, {
          youtubeUrl: newVideoState.videoUrl,
          isYoutubePlaying: newVideoState.playbackState === 'play',
          currentTime: newVideoState.currentTime,
          youtubeQueue: newVideoState.queue,
          currentIndex: newVideoState.index
        })) {
          if (onVideoStateChangeRef.current) {
            onVideoStateChangeRef.current(newVideoState);
          }
          setSyncStatus('synced');
          console.log(`[${username}] Video state updated from ${msg.sender}`);
        }
      }

      else if (msg.type === 'sync') {
        if (syncTimeoutRef.current) {
          clearTimeout(syncTimeoutRef.current);
          syncTimeoutRef.current = null;
        }

        if (msg.videoUrl) {
          const syncedVideoState = {
            videoUrl: msg.videoUrl,
            playbackState: msg.playbackState,
            currentTime: msg.currentTime || 0,
            queue: msg.queue || [],
            index: msg.index || 0,
          };

          if (onVideoStateChangeRef.current) {
            onVideoStateChangeRef.current(syncedVideoState);
          }
          setSyncStatus('synced');
          console.log(`[${username}] Received video state sync from server.`);
        } else {
          setSyncStatus('synced');
          console.log(`[${username}] Server has no video state to sync.`);
        }
      }

      else if (msg.type === 'watchHours' && msg.sender !== username) {
        handleWatchHoursUpdate(msg.sender, msg.watchHours);
      }

    } catch (err) {
      console.error(`[${username}] Error parsing WebSocket message:`, err, 'Raw message:', event.data);
    }
  }, [username, areVideoStatesEqual, handleWatchHoursUpdate]);

  const connect = useCallback(() => {
    if (isUnmountingRef.current) return;
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(`[${username}] Max reconnect attempts reached.`);
      return;
    }

    console.log(`[${username}] Connecting to WebSocket... (Attempt ${reconnectAttemptsRef.current + 1})`);
    
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    }

    const socket = new WebSocket(WS_URL);
    wsRef.current = socket;

    socket.onopen = () => {
      if (isUnmountingRef.current) {
        socket.close();
        return;
      }
      
      console.log(`[${username}] WebSocket connected.`);
      setIsConnected(true);
      setSyncStatus('waiting');
      reconnectAttemptsRef.current = 0;
      
      socket.send(username);
      
      const currentVideoState = videoStateRef.current;
      if (currentVideoState && currentVideoState.youtubeUrl) {
        sendVideoState(currentVideoState, true);
      }
      
      if (pendingVideoStateRef.current) {
        sendVideoState(pendingVideoStateRef.current, true);
        pendingVideoStateRef.current = null;
      }

      setTimeout(() => {
        if (isUnmountingRef.current) return;
        const currentState = videoStateRef.current;
        if (!currentState || !currentState.youtubeUrl) {
          requestVideoSync();
        } else {
          setSyncStatus('synced');
        }
      }, SYNC_REQUEST_DELAY);
    };

    socket.onmessage = handleWebSocketMessage;

    socket.onclose = (event) => {
      console.warn(`[${username}] WebSocket closed (Code ${event.code}, Reason: ${event.reason})`);
      setIsConnected(false);
      setSyncStatus('waiting');

      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
        syncTimeoutRef.current = null;
      }

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (!isUnmountingRef.current && event.code !== 1000) {
        reconnectAttemptsRef.current++;
        const delay = Math.min(
          RECONNECT_INTERVAL_MS * Math.pow(EXPONENTIAL_BACKOFF_FACTOR, reconnectAttemptsRef.current - 1),
          30000
        );
        console.log(`[${username}] Reconnecting in ${Math.floor(delay)}ms...`);
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      } else if (event.code === 1000) {
        console.log(`[${username}] WebSocket closed normally with code 1000.`);
      }
    };

    socket.onerror = (error) => {
      console.error(`[${username}] WebSocket error:`, error);
      setIsConnected(false);
      setSyncStatus('waiting');
    };
  }, [username, sendVideoState, requestVideoSync, handleWebSocketMessage]);

  // Initialize connection once
  useEffect(() => {
    if (!connectionInitializedRef.current) {
      isUnmountingRef.current = false;
      connectionInitializedRef.current = true;
      connect();
    }

    return () => {
      isUnmountingRef.current = true;
      connectionInitializedRef.current = false;
      setIsConnected(false);
      setSyncStatus('waiting');

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
        syncTimeoutRef.current = null;
      }

      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        
        if (wsRef.current.readyState === WebSocket.OPEN) {
          console.log(`[${username}] Closing WebSocket (Component unmount)`);
          wsRef.current.close(1000, 'Component unmounting');
        }
        wsRef.current = null;
      }
    };
  }, []); // Empty dependency array - only run once

  // Separate effect for username changes (if username can change)
  useEffect(() => {
    if (connectionInitializedRef.current && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // If username changes after connection, we might need to reconnect
      // This is optional - only if your username can change during the session
      console.log(`[${username}] Username changed, may need to reconnect`);
    }
  }, [username]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Send video state when it changes (debounced)
  useEffect(() => {
    if (videoState && isConnected && connectionInitializedRef.current) {
      const timeoutId = setTimeout(() => {
        sendVideoState(videoState);
      }, 100); // Small debounce to prevent rapid fire

      return () => clearTimeout(timeoutId);
    }
  }, [videoState, isConnected, sendVideoState]);

  const sendMessage = useCallback(() => {
    const trimmedInput = input.trim();
    
    if (!trimmedInput) {
      console.log(`[${username}] Message input is empty, not sending.`);
      return;
    }

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn(`[${username}] WebSocket is not open, cannot send message. ReadyState:`, 
        wsRef.current ? wsRef.current.readyState : 'No WebSocket');
      return;
    }

    const now = Date.now();
    if (lastSentMessageRef.current === trimmedInput) {
      console.log(`[${username}] Preventing duplicate message send:`, trimmedInput);
      return;
    }

    try {
      const messageData = {
        type: 'message',
        content: trimmedInput,
        timestamp: now
      };

      wsRef.current.send(JSON.stringify(messageData));
      console.log(`[${username}] Message sent:`, trimmedInput);
      
      lastSentMessageRef.current = trimmedInput;
      setInput('');

      setTimeout(() => {
        if (lastSentMessageRef.current === trimmedInput) {
          lastSentMessageRef.current = '';
        }
      }, DUPLICATE_CHECK_WINDOW);

    } catch (err) {
      console.error(`[${username}] Error sending message:`, err);
    }
  }, [input, username]);

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const getSyncStatusIndicator = () => {
    switch (syncStatus) {
      case 'syncing':
        return { color: 'bg-yellow-400', title: 'Syncing video state...' };
      case 'synced':
        return { color: 'bg-green-400', title: 'Video state synchronized' };
      default:
        return { color: 'bg-gray-400', title: 'Waiting for sync' };
    }
  };

  const syncIndicator = getSyncStatusIndicator();

  return (
    <>
      <div className="mt-6 bg-black bg-opacity-40 backdrop-blur-md rounded-3xl shadow-2xl p-4 max-h-96 flex flex-col border border-pink-500 mb-32">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-pink-300 text-xl font-bold text-center drop-shadow-[0_0_5px_rgba(255,105,180,0.7)] flex items-center justify-center gap-2">
            Chatroom {!isConnected && <span className="text-red-400 text-sm">(Connecting...)</span>}
            {typingUsers.length > 0 && (
              <span className="text-pink-400 italic text-sm">
                {typingUsers.filter(user => user !== username).join(', ')} is Typing...
              </span>
            )}
          </h3>
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${syncIndicator.color}`} 
                 title={syncIndicator.title} />
            <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'}`} 
                 title={isConnected ? 'Connected' : 'Disconnected'} />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto mb-2 px-2" style={{ minHeight: '200px' }}>
          {messages.length === 0 ? (
            <div className="text-gray-400 text-center py-4">
              {isConnected ? 'No messages yet...' : 'Connecting to chat...'}
            </div>
          ) : (
            messages.map((msg) => {
              const isCurrentUser = msg.sender === username;
              return (
                <div
                  key={msg.id || `${msg.sender}-${msg.timestamp}`}
                  className={`mb-1 p-2 rounded-lg ${isCurrentUser ? 'bg-pink-700 ml-auto' : 'bg-gray-700 mr-auto'}`}
                  style={{ maxWidth: '80%' }}
                >
                  <span className={`font-semibold ${isCurrentUser ? 'text-white' : 'text-pink-400'}`}>
                    {isCurrentUser ? 'You' : msg.sender}:
                  </span>
                  <span className="text-white ml-1">{msg.content}</span>
                </div>
              );
            })
          )}
          {/* Typing indicator */}
          {false}
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder={isConnected ? "Type a message..." : "Connecting..."}
            disabled={!isConnected}
            className="flex-1 rounded-md px-3 py-2 bg-black bg-opacity-60 text-white placeholder-pink-400 focus:outline-none focus:ring-2 focus:ring-pink-500 disabled:opacity-50"
            aria-label="Chat message input"
          />

          <button
            onClick={sendMessage}
            disabled={!isConnected || !input.trim()}
            className="h-8 px-4 bg-pink-600 rounded-full text-white font-extrabold text-lg hover:bg-pink-700 transition duration-300 shadow-pink-400/70 shadow-lg flex items-center justify-center"
            aria-label="Send chat message"
          >
            Send
          </button>
        </div>
      </div>
      
      <OnlineUsersSection onlineUsers={onlineUsers} />
    </>
  );
}
