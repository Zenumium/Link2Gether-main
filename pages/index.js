import { useEffect, useRef, useState, useCallback } from 'react';
import ChatRoom from '../components/ChatRoom';

export default function Home() {
  const audioRef = useRef(null);
  const youtubeRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const sendVideoStateRef = useRef(null);
  const [audioContext, setAudioContext] = useState(null);
  const [audioSrc] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeInput, setYoutubeInput] = useState('');
  const [urlError, setUrlError] = useState('');
  const [isYoutubePlaying, setIsYoutubePlaying] = useState(false);
  const [volume, setVolume] = useState(1);

  // State for persistent username
  const [chatUsername, setChatUsername] = useState('');
  const [discordConnected, setDiscordConnected] = useState(false);

  // useEffect to manage persistent username and Discord avatar
  useEffect(() => {
    if (typeof window !== 'undefined') {
      let storedUsername = localStorage.getItem('chatUsername');
      let storedAvatar = localStorage.getItem('discordAvatar');
      let storedUserId = localStorage.getItem('discordUserId');

      if (!storedUsername) {
        storedUsername = "User" + Math.floor(Math.random() * 10000);
        localStorage.setItem('chatUsername', storedUsername);
      }
      setChatUsername(storedUsername);

      if (storedAvatar && storedUserId) {
        setDiscordConnected(true);
      }

      // Check for Discord username, avatar, and userId in URL query param and update state
      const urlParams = new URLSearchParams(window.location.search);
      const usernameFromUrl = urlParams.get('username');
      const avatarFromUrl = urlParams.get('avatar');
      const userIdFromUrl = urlParams.get('userId');

      if (usernameFromUrl) {
        setChatUsername(usernameFromUrl);
        localStorage.setItem('chatUsername', usernameFromUrl);
      }
      if (avatarFromUrl) {
        localStorage.setItem('discordAvatar', avatarFromUrl);
      }
      if (userIdFromUrl) {
        localStorage.setItem('discordUserId', userIdFromUrl);
      }
      if (usernameFromUrl && avatarFromUrl && userIdFromUrl) {
        setDiscordConnected(true);
      }

      // Remove query params from URL and redirect to main page without params
      if (usernameFromUrl) {
        window.history.replaceState({}, document.title, window.location.origin + window.location.pathname);
        window.location.href = window.location.origin + '/';
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedVolume = localStorage.getItem('volume');
      if (savedVolume !== null) {
        setVolume(parseFloat(savedVolume));
      }
    }
  }, []);

  const [youtubeHistory, setYoutubeHistory] = useState([]);
  const [searchTerm] = useState('');
  const [sortBy] = useState('Difficulty');

  // New queue state and current index
  const [youtubeQueue, setYoutubeQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);

  // State to toggle ChatRoom visibility
  const [showChatRoom, setShowChatRoom] = useState(false);

  useEffect(() => {
    let context;
    try {
      const AudioContext = window.AudioContext || window.AudioContext;
      context = new AudioContext();
      setAudioContext(context);
    } catch (error) {
      console.error("Error initializing audio context:", error);
    }
    return () => {
      if (context && context.state !== 'closed') {
        context.close();
      }
    };
  }, []);

  useEffect(() => {
    if (!audioContext || !audioRef.current) return;

    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }

    try {
      const source = audioContext.createMediaElementSource(audioRef.current);
      source.connect(audioContext.destination);
      sourceNodeRef.current = source;
    } catch (error) {
      console.error("Error connecting audio source:", error);
    }
  }, [audioContext, audioSrc]);

  useEffect(() => {
    if (!audioSrc) return;

    if (audioRef.current) {
      try {
        if (!audioRef.current.paused) {
          audioRef.current.pause();
        }
        audioRef.current.src = audioSrc;
        audioRef.current.load();
        audioRef.current.volume = volume;
      } catch (error) {
        console.error("Error loading audio source:", error);
      }
    }
  }, [audioSrc, volume]);

  useEffect(() => {
    if (!audioRef.current) return;

    const handleAudioError = (e) => {
      console.error("Audio error:", e);
    };

    audioRef.current.addEventListener('error', handleAudioError);

    return () => {
      if (audioRef.current) {
        audioRef.current.removeEventListener('error', handleAudioError);
      }
    };
  }, []);

  // Play video from queue at currentIndex
  useEffect(() => {
    if (currentIndex >= 0 && currentIndex < youtubeQueue.length) {
      const url = youtubeQueue[currentIndex];
      setYoutubeUrl(url);
      setIsYoutubePlaying(true);
    } else {
      setYoutubeUrl('');
      setIsYoutubePlaying(false);
    }
  }, [currentIndex, youtubeQueue]);

  // Add youtubeUrl to history when it changes
  useEffect(() => {
    if (youtubeUrl && youtubeUrl.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/)) {
      const videoId = youtubeUrl.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/)[1];
      setYoutubeHistory(prev => {
        if (prev.some(item => item.src === youtubeUrl)) {
          return prev;
        }
        return [
          ...prev,
          {
            name: `YouTube - ${videoId}`,
            src: youtubeUrl,
            type: 'youtube',
            timestamp: new Date().toLocaleString()
          }
        ];
      });
    }
  }, [youtubeUrl]);

  // Handle end of YouTube video to play next in queue
  useEffect(() => {
    const handleMessage = (event) => {
      if (event.data && typeof event.data === 'string' && event.data.includes('onStateChange')) {
        try {
          const data = JSON.parse(event.data);
          if (data.event === 'onStateChange' && data.info === 0) {
            if (currentIndex + 1 < youtubeQueue.length) {
              setCurrentIndex(currentIndex + 1);
            } else {
              setIsYoutubePlaying(false);
            }
          }
        } catch (error) {
          console.error("Error parsing YouTube player message:", error);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [currentIndex, youtubeQueue]);

  const addToQueue = (url) => {
    if (!url) return;
    if (!url.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/)) {
      setUrlError('Please enter a valid YouTube URL.');
      return;
    }
    setUrlError('');
    setYoutubeQueue(prev => [...prev, url]);
    if (currentIndex === -1) {
      setCurrentIndex(0);
    }
  };

  const handleAddToQueue = () => {
    addToQueue(youtubeInput);
    setYoutubeInput('');
  };

  const handlePlay = () => {
    if (youtubeInput) {
      addToQueue(youtubeInput);
      setYoutubeInput('');
    }
    if (currentIndex >= 0 && currentIndex < youtubeQueue.length) {
      if (youtubeRef.current) {
        youtubeRef.current.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
      }
      setIsYoutubePlaying(true);
      setIsPlaying(true);
    }
  };

  const handlePause = () => {
    if (youtubeRef.current) {
      youtubeRef.current.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
      setIsYoutubePlaying(false);
      setIsPlaying(false);
    }
  };

  const handleStop = () => {
    if (youtubeRef.current) {
      youtubeRef.current.contentWindow.postMessage('{"event":"command","func":"stopVideo","args":""}', '*');
      setIsYoutubePlaying(false);
      setIsPlaying(false);
    }
  };

  const handleNext = () => {
    if (currentIndex + 1 < youtubeQueue.length) {
      setCurrentIndex(prevIndex => {
        const newIndex = prevIndex + 1;
        if (newIndex < youtubeQueue.length) {
          return newIndex;
        }
        return prevIndex;
      });
      setIsYoutubePlaying(true);
    }
  };

  const handlePrevious = () => {
    if (currentIndex > 0) {
      setCurrentIndex(prevIndex => {
        const newIndex = prevIndex - 1;
        if (newIndex >= 0) {
          return newIndex;
        }
        return prevIndex;
      });
      setIsYoutubePlaying(true);
    }
  };

  const playFromHistory = (item) => {
    if (item && item.src) {
      const indexInQueue = youtubeQueue.indexOf(item.src);
      if (indexInQueue !== -1) {
        setCurrentIndex(indexInQueue);
        setIsYoutubePlaying(true);
      } else {
        setYoutubeQueue(prev => [...prev, item.src]);
        setCurrentIndex(prevIndex => prevIndex + 1);
        setIsYoutubePlaying(true);
      }
    }
  };

  const handleVolumeChange = (e) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (typeof window !== 'undefined') {
      localStorage.setItem('volume', newVolume.toString());
    }
  };

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    if (youtubeRef.current && isYoutubePlaying) {
      const volumePercent = Math.round(volume * 100);
      youtubeRef.current.contentWindow.postMessage(
        JSON.stringify({
          event: 'command',
          func: 'setVolume',
          args: [volumePercent]
        }),
        '*'
      );
    }
  }, [volume, isYoutubePlaying]);

  useEffect(() => {
    if (youtubeRef.current && youtubeUrl) {
      const volumePercent = Math.round(volume * 100);
      youtubeRef.current.contentWindow.postMessage(
        JSON.stringify({
          event: 'command',
          func: 'setVolume',
          args: [volumePercent]
        }),
        '*'
      );
    }
  }, [youtubeUrl, volume]);

  useEffect(() => {
    if (!youtubeRef.current) return;
    if (!youtubeUrl) return;

    if (isYoutubePlaying) {
      youtubeRef.current.contentWindow.postMessage(
        JSON.stringify({
          event: 'command',
          func: 'playVideo',
          args: []
        }),
        '*'
      );
    } else {
      youtubeRef.current.contentWindow.postMessage(
        JSON.stringify({
          event: 'command',
          func: 'pauseVideo',
          args: []
        }),
        '*'
      );
    }
  }, [youtubeUrl, isYoutubePlaying]);

  const filteredHistory = youtubeHistory.filter(item =>
    item.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const sortedHistory = filteredHistory.sort((a, b) => {
    if (sortBy === 'Difficulty') {
      return a.name.localeCompare(b.name);
    } else if (sortBy === 'Date Added') {
      return new Date(b.timestamp) - new Date(a.timestamp);
    }
    return 0;
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-pink-900 to-purple-900 flex flex-col">
      <header className="flex items-center justify-between px-6 py-3 bg-black bg-opacity-50 backdrop-blur-md border-b border-pink-600 shadow-lg">
        <div className="flex space-x-4">
          <button
            onClick={() => setShowChatRoom(prev => !prev)}
            className="bg-pink-600 hover:bg-pink-700 text-white font-bold px-4 py-2 rounded-md shadow-pink-400/70 shadow-lg transition duration-300"
            aria-label="Toggle Chatroom visibility"
          >
            {showChatRoom ? 'Hide Chatroom' : 'Show Chatroom'}
          </button>
          {!discordConnected ? (
            <button
              onClick={() => {
                const DISCORD_CLIENT_ID = '1379082773410873356';
                const REDIRECT_URI = 'http://localhost:3000/api/discord-auth';
                const DISCORD_OAUTH_URL = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
                window.location.href = DISCORD_OAUTH_URL;
              }}
              className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-4 py-2 rounded-md shadow-blue-400/70 shadow-lg transition duration-300"
              aria-label="Connect with Discord"
            >
              Connect with Discord
            </button>
          ) : (
            <button
              onClick={() => {
                // Disconnect from Discord
                setDiscordConnected(false);
                
                // Generate new random username
                const defaultUsername = "User" + Math.floor(Math.random() * 10000);
                setChatUsername(defaultUsername);
                
                // Update localStorage with new username
                localStorage.setItem('chatUsername', defaultUsername);
                
                // Optional: Clear any Discord-related data from localStorage
                localStorage.removeItem('discordUserId');
                localStorage.removeItem('discordAccessToken');
                localStorage.removeItem('discordAvatar');
              }}
              className="bg-red-600 hover:bg-red-700 text-white font-bold px-4 py-2 rounded-md shadow-red-400/70 shadow-lg transition duration-300"
              aria-label="Disconnect Discord"
            >
              Disconnect Discord
            </button>
          )}
        </div>
        {discordConnected && localStorage.getItem('discordAvatar') && (
          <img
            src={`https://cdn.discordapp.com/avatars/${localStorage.getItem('discordUserId')}/${localStorage.getItem('discordAvatar')}.png`}
            alt="Discord Profile"
            className="w-10 h-10 rounded-full border-2 border-pink-600"
          />
        )}
      </header>

      <main className="flex flex-1 px-6 py-4 space-x-6">
        <section className={`flex-1 bg-black bg-opacity-40 backdrop-blur-md rounded-3xl shadow-2xl p-6 flex flex-col transition-all duration-700 ease-[cubic-bezier(0.4,0,0.2,1)] ${showChatRoom ? 'mr-6' : 'mr-0'}`}>
          <h1 className="text-center text-pink-400 text-4xl font-extrabold mb-6 drop-shadow-[0_0_10px_rgba(255,105,180,0.7)]">Link2Gether</h1>
          <div className="mb-6 flex flex-col space-y-4">
            <label htmlFor="youtube-url" className="text-pink-300 text-lg font-semibold drop-shadow-[0_0_5px_rgba(255,105,180,0.7)]">YouTube URL:</label>
            {urlError && (
              <p className="mb-2 text-red-500 text-sm font-semibold">{urlError}</p>
            )}
            <div className="flex items-center rounded-lg overflow-hidden shadow-lg bg-gradient-to-r from-pink-600 to-purple-700 bg-opacity-30 border border-pink-500 backdrop-blur-md">
              <input
                id="youtube-url"
                type="text"
                value={youtubeInput}
                onChange={(e) => {
                  setYoutubeInput(e.target.value);
                  if (urlError) setUrlError('');
                }}
                placeholder="Enter YouTube video URL"
                className="px-4 py-3 bg-transparent text-white placeholder-pink-300 focus:outline-none flex-grow drop-shadow-[0_0_5px_rgba(255,105,180,0.7)]"
                aria-label="YouTube video URL input"
              />
              <button
                onClick={handleAddToQueue}
                className="bg-pink-500 hover:bg-pink-600 text-white px-6 py-3 font-bold transition duration-300 shadow-pink-400/70 shadow-lg"
              >
                Add to Queue
              </button>
            </div>
          </div>
          {(youtubeUrl && youtubeQueue.length > 0 && currentIndex >= 0) && (
            <iframe
              ref={youtubeRef}
              width="100%"
              height="350"
              src={`https://www.youtube.com/embed/${youtubeUrl.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/)?.[1] || ''}?enablejsapi=1&version=3&autoplay=1`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              title="YouTube video player"
              className="mb-4 rounded-3xl shadow-2xl border-4 border-pink-600 backdrop-blur-md bg-opacity-30"
              style={{ backdropFilter: 'blur(10px)' }}
            />
          )}
          <div className="flex flex-wrap items-center space-x-4 space-y-0 justify-center mb-8">
            <button
              onClick={handlePrevious}
              disabled={currentIndex <= 0}
              className="h-12 px-6 bg-pink-600 rounded-full text-white font-extrabold text-lg hover:bg-pink-700 transition duration-300 shadow-pink-400/70 shadow-lg flex items-center justify-center"
              aria-label="Previous video"
            >
              Previous ⏮️
            </button>
            <button
              onClick={handlePlay}
              disabled={isPlaying || isYoutubePlaying}
              className="h-12 px-6 bg-pink-600 rounded-full text-white font-extrabold text-lg hover:bg-pink-700 transition duration-300 disabled:opacity-50 shadow-pink-400/70 shadow-lg flex items-center justify-center"
              aria-label="Play YouTube video"
            >
              Play ▶
            </button>
            <button
              onClick={handlePause}
              disabled={!isPlaying && !isYoutubePlaying}
              className="h-12 px-6 bg-purple-600 rounded-full text-white font-extrabold text-lg hover:bg-purple-700 transition duration-300 disabled:opacity-50 shadow-purple-400/70 shadow-lg flex items-center justify-center"
              aria-label="Pause YouTube video"
            >
              Pause ▐▐
            </button>
            <button
              onClick={handleStop}
              disabled={!isPlaying && !isYoutubePlaying}
              className="h-12 px-6 bg-pink-600 rounded-full text-white font-extrabold text-lg hover:bg-pink-700 transition duration-300 disabled:opacity-50 shadow-pink-400/70 shadow-lg flex items-center justify-center"
              aria-label="Stop YouTube video"
            >
              Stop ◼
            </button>
            <button
              onClick={handleNext}
              className="h-12 px-6 bg-pink-600 rounded-full text-white font-extrabold text-lg hover:bg-pink-700 transition duration-300 shadow-pink-400/70 shadow-lg flex items-center justify-center"
              aria-label="Next"
            >
              Next ⏭️
            </button>
          </div>
          <div className="w-full max-w-md flex flex-col items-center mb-6 mx-auto">
            <label htmlFor="volume-control" className="text-pink-300 mb-3 font-semibold text-lg drop-shadow-[0_0_5px_rgba(255,105,180,0.7)]">Volume: {Math.round(volume * 100)}%</label>
            <input
              id="volume-control"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={handleVolumeChange}
              className="w-full rounded-full accent-pink-500 cursor-pointer"
              aria-label="Volume control"
            />
          </div>
        </section>

        {/* Right Panel - YouTube History */}
        <aside className="w-96 bg-black bg-opacity-40 backdrop-blur-md rounded-3xl shadow-2xl p-6 max-h-[calc(100vh-96px)] overflow-y-auto border border-pink-500 flex flex-col">
          <h2 className="text-pink-300 text-2xl mb-4 font-bold tracking-wide text-center drop-shadow-[0_0_5px_rgba(255,105,180,0.7)]">YouTube History</h2>
          <div className="text-pink-400 text-center font-semibold mb-4">
            Next in Queue: {currentIndex + 1 < youtubeQueue.length ? youtubeQueue[currentIndex + 1] : 'No next video'}
          </div>
          <div className="flex justify-between items-center mb-4">
            <div className="flex space-x-4 text-pink-400 font-semibold text-sm">
            </div>
            <div className="flex items-center space-x-2">
              <label className="text-pink-400 text-sm font-semibold flex items-center space-x-1 cursor-pointer select-none">
              </label>
            </div>
          </div>
          {sortedHistory.length === 0 ? (
            <p className="text-pink-400 text-center">No YouTube history found.</p>
          ) : (
            <ul className="divide-y divide-pink-600 flex-1 overflow-y-auto">
              {sortedHistory.map((item, index) => (
                <li key={index} className="py-3 flex items-center justify-between">
                  <div className="flex-1">
                    <p className="text-white font-semibold truncate drop-shadow-[0_0_5px_rgba(255,105,180,0.7)]">{item.name}</p>
                    <p className="text-pink-400 text-sm">{item.timestamp}</p>
                    <p className="text-pink-500 text-xs">{item.type}</p>
                  </div>
                  <button
                    onClick={() => playFromHistory(item)}
                    className="ml-5 bg-pink-500 hover:bg-pink-600 text-white px-4 py-2 rounded-full transition duration-300 text-sm font-semibold shadow-pink-400/70 shadow-lg"
                  >
                    Play
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Chatroom below YouTube History */}
        {/* Animate ChatRoom width to smoothly hide/show */}
        {chatUsername && (
          <section
            className={`bg-black bg-opacity-40 backdrop-blur-md rounded-3xl shadow-2xl p-6 max-h-[calc(100vh-96px)] overflow-y-auto border border-pink-500 flex flex-col ml-6 transition-[width,opacity] duration-700 ease-[cubic-bezier(0.4,0,0.2,1)] ${
              showChatRoom ? 'w-96 opacity-100 pointer-events-auto' : 'w-0 opacity-0 pointer-events-none'
            }`}
            style={{ willChange: 'width, opacity' }}
          >
            <ChatRoom
              username={chatUsername}
              videoState={{
                youtubeUrl,
                isYoutubePlaying,
                currentIndex,
                youtubeQueue
              }}
              onVideoStateChange={({ videoUrl, playbackState, queue, index }) => {
                if (queue && Array.isArray(queue) && queue.length > 0) {
                  setYoutubeQueue(queue);
                }
                if (typeof index === 'number' && index >= 0) {
                  setCurrentIndex(index);
                }
                if (videoUrl) {
                  setYoutubeUrl(videoUrl);
                }
                if (playbackState === 'play') {
                  setIsYoutubePlaying(true);
                } else if (playbackState === 'pause' || playbackState === 'stop') {
                  setIsYoutubePlaying(false);
                }
              }}
              onSendVideoState={(sendVideoState) => {
                // Store sendVideoState callback to call on pause/stop
                sendVideoStateRef.current = sendVideoState;
              }}
            />
          </section>
        )}
      </main>

      {/* Bottom Navigation Bar */}
      <nav className="flex items-center justify-center px-6 py-3 bg-black bg-opacity-50 backdrop-blur-md border-t border-pink-600 shadow-lg">
        <p className="text-sm text-white text-center">
          © {new Date().getFullYear()} <span className="font-bold">Projeckt Aqua</span>. All rights reserved.
        </p>
        <p className="text-sm text-white">
          <span className="font-bold">V1.0</span>
        </p>
      </nav>
    </div>
  );
}