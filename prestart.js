// ============================================================
// cc-ava: Main Entry Point (prestart)
// ============================================================
// Hooks into CrossCode's dialog event system to intercept
// dialog lines and generate/play TTS audio for each one.
//
// All module code is inlined here to avoid async loading issues.
// ============================================================

(function () {
    'use strict';

    if (window._ccvaDebug) console.log('[CC-VA] ===================================');
    if (window._ccvaDebug) console.log('[CC-VA] CrossCode Artificial Voice Acting Mod Loading');
    if (window._ccvaDebug) console.log('[CC-VA] ===================================');

    // ---- Inline: TTS Client ----
    var VA_TTS_CLIENT = {
        API_BASE: 'https://api.elevenlabs.io/v1',

        cleanText: function (text, pronunciations, model) {
            if (!text || typeof text !== 'string') return null;
            var cleaned = text;
            // Remove CC formatting: \c[N], \v[...], \s[...], \i[...], \size[N], etc.
            cleaned = cleaned.replace(/\\c\[\d+\]/g, '');
            cleaned = cleaned.replace(/\\v\[misc\.localNum\.(\d+)\]/g, '$1');
            cleaned = cleaned.replace(/\\v\[[^\]]+\]/g, '');
            cleaned = cleaned.replace(/\\s\[[^\]]+\]/g, '');
            cleaned = cleaned.replace(/\\i\[[^\]]+\]/g, '');
            cleaned = cleaned.replace(/\\size\[\d+\]/g, '');
            cleaned = cleaned.replace(/\\[a-zA-Z]+\[[^\]]*\]/g, '');
            cleaned = cleaned.replace(/<<[A-Z]<<\[CHANGED[^\]]*\]/g, '');
            // Remove brackets but keep the text inside (preserves [Seeker], [Bergen Village], etc.)
            cleaned = cleaned.replace(/\[([^\]]*)\]/g, '$1');
            // Apply pronunciation corrections only on v3 model (IPA notation support)
            if (pronunciations && model === 'eleven_v3') {
                var words = Object.keys(pronunciations);
                for (var i = 0; i < words.length; i++) {
                    var regex = new RegExp('\\b' + words[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
                    cleaned = cleaned.replace(regex, pronunciations[words[i]]);
                }
            }
            // Clean up whitespace
            cleaned = cleaned.replace(/\s+/g, ' ').trim();
            return cleaned || null;
        },

        shouldSkip: function (text, skipPatterns) {
            if (!text) return true;
            if (!skipPatterns) return false;
            for (var i = 0; i < skipPatterns.length; i++) {
                try {
                    if (new RegExp(skipPatterns[i]).test(text)) return true;
                } catch (e) { }
            }
            return false;
        },

        getCacheKey: function (text, voiceId) {
            var str = voiceId + ':' + text;
            var hash = 0;
            for (var i = 0; i < str.length; i++) {
                hash = ((hash << 5) - hash) + str.charCodeAt(i);
                hash = hash & hash;
            }
            return (hash >>> 0).toString(16).padStart(8, '0');
        },

        generateSpeech: function (text, voiceId, apiKey, model) {
            var url = this.API_BASE + '/text-to-speech/' + voiceId;
            return fetch(url, {
                method: 'POST',
                headers: {
                    'Accept': 'audio/mpeg',
                    'Content-Type': 'application/json',
                    'xi-api-key': apiKey
                },
                body: JSON.stringify({
                    text: text,
                    model_id: model || 'eleven_multilingual_v2',
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                        style: 0.0,
                        use_speaker_boost: true
                    }
                })
            }).then(function (response) {
                if (!response.ok) {
                    return response.text().then(function (errText) {
                        throw new Error('[CC-VA] API error ' + response.status + ': ' + errText);
                    });
                }
                return response.arrayBuffer();
            });
        }
    };

    // ---- Inline: Audio Manager ----
    var VA_AUDIO_MANAGER = {
        _audioContext: null,
        _currentSource: null,
        _gainNode: null,
        _volume: 0.8,
        _playing: false,

        init: function (volume) {
            this._volume = (typeof volume === 'number') ? volume : 0.8;
            try {
                this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
                this._gainNode = this._audioContext.createGain();
                this._gainNode.gain.value = this._volume;
                this._gainNode.connect(this._audioContext.destination);
                if (window._ccvaDebug) console.log('[CC-VA] Audio manager initialized (volume: ' + this._volume + ')');
            } catch (e) {
                console.error('[CC-VA] Failed to create AudioContext:', e);
            }
        },

        setVolume: function (vol) {
            this._volume = Math.max(0, Math.min(1, vol));
            if (this._gainNode) this._gainNode.gain.value = this._volume;
        },

        stop: function () {
            if (this._currentSource) {
                try { this._currentSource.stop(); } catch (e) { }
                this._currentSource = null;
            }
            this._playing = false;
        },

        play: function (audioData, pitch, voiceVolume) {
            var self = this;
            this.stop();
            if (!this._audioContext) return Promise.reject(new Error('No AudioContext'));
            if (this._audioContext.state === 'suspended') this._audioContext.resume();

            // Per-voice volume: 0-100 scale, default 100
            var vVol = (typeof voiceVolume === 'number') ? Math.max(0, Math.min(1, voiceVolume / 100)) : 1.0;

            return this._audioContext.decodeAudioData(audioData.slice(0))
                .then(function (audioBuffer) {
                    var source = self._audioContext.createBufferSource();
                    source.buffer = audioBuffer;
                    if (pitch !== undefined && pitch !== 1.0) {
                        source.playbackRate.value = pitch;
                    }

                    // Per-clip gain node for fade-out to prevent end-of-clip clipping
                    var clipGain = self._audioContext.createGain();
                    clipGain.gain.value = vVol;
                    var fadeOutDuration = 0.075; // 75ms fade-out
                    var fadeOutStart = Math.max(0, audioBuffer.duration - fadeOutDuration);
                    var now = self._audioContext.currentTime;
                    clipGain.gain.setValueAtTime(vVol, now + fadeOutStart);
                    clipGain.gain.linearRampToValueAtTime(0.0, now + fadeOutStart + fadeOutDuration);

                    // Chain: source -> clipGain -> masterGain -> destination
                    source.connect(clipGain);
                    clipGain.connect(self._gainNode);

                    self._currentSource = source;
                    self._playing = true;
                    return new Promise(function (resolve) {
                        source.onended = function () {
                            if (self._currentSource === source) {
                                self._currentSource = null;
                                self._playing = false;
                            }
                            clipGain.disconnect();
                            resolve();
                        };
                        source.start(0);
                        if (window._ccvaDebug) console.log('[CC-VA] Audio playing (' + audioBuffer.duration.toFixed(1) + 's)');
                    });
                })
                .catch(function (err) {
                    console.error('[CC-VA] Audio decode/play error:', err);
                    self._playing = false;
                });
        }
    };

    // ---- Inline: Cache Manager ----
    var VA_CACHE_MANAGER = {
        _cacheDir: '',
        _fs: null,
        _path: null,
        _ready: false,

        init: function () {
            try {
                this._fs = require('fs');
                this._path = require('path');
                var gameRoot = this._path.resolve('.');
                this._cacheDir = this._path.join(gameRoot, 'assets', 'mod-data', 'cc-ava', 'cache');
                this._mkdirRecursive(this._cacheDir);
                this._ready = true;
                if (window._ccvaDebug) console.log('[CC-VA] Cache dir: ' + this._cacheDir);
            } catch (e) {
                console.error('[CC-VA] Cache init failed:', e);
            }
        },

        _mkdirRecursive: function (dirPath) {
            var parts = dirPath.split(this._path.sep);
            var current = '';
            for (var i = 0; i < parts.length; i++) {
                current = current ? this._path.join(current, parts[i]) : parts[i];
                if (current.endsWith(':')) { current += this._path.sep; continue; }
                if (!this._fs.existsSync(current)) this._fs.mkdirSync(current);
            }
        },

        has: function (cacheKey, charName) {
            if (!this._ready) return false;
            var dir = charName ? this._path.join(this._cacheDir, charName) : this._cacheDir;
            return this._fs.existsSync(this._path.join(dir, cacheKey + '.mp3'));
        },

        get: function (cacheKey, charName) {
            if (!this._ready) return null;
            try {
                var dir = charName ? this._path.join(this._cacheDir, charName) : this._cacheDir;
                var buffer = this._fs.readFileSync(this._path.join(dir, cacheKey + '.mp3'));
                return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
            } catch (e) { return null; }
        },

        set: function (cacheKey, charName, audioData, text) {
            if (!this._ready) return;
            try {
                var dir = charName ? this._path.join(this._cacheDir, charName) : this._cacheDir;
                if (!this._fs.existsSync(dir)) this._mkdirRecursive(dir);
                this._fs.writeFileSync(
                    this._path.join(dir, cacheKey + '.mp3'),
                    Buffer.from(audioData)
                );
                // Append to cache log for index generation
                this._appendLog(charName, text, cacheKey);
                if (window._ccvaDebug) console.log('[CC-VA] Cached: ' + (charName ? charName + '/' : '') + cacheKey + '.mp3');
            } catch (e) {
                console.error('[CC-VA] Cache write error:', e);
            }
        },

        _appendLog: function (charName, text, cacheKey) {
            try {
                var logPath = this._path.join(this._cacheDir, 'cache-log.csv');
                // Write header if file doesn't exist
                if (!this._fs.existsSync(logPath)) {
                    this._fs.writeFileSync(logPath, 'Character,Voice Line,Filename,Timestamp\n', 'utf-8');
                }
                var escaped = (text || '').replace(/"/g, '""');
                var line = '"' + (charName || '') + '","' + escaped + '","' + cacheKey + '.mp3","' + new Date().toISOString() + '"\n';
                this._fs.appendFileSync(logPath, line, 'utf-8');
            } catch (e) {
                // Non-critical, don't break caching
            }
        },

        delete: function (cacheKey, charName) {
            if (!this._ready) return;
            try {
                var dir = charName ? this._path.join(this._cacheDir, charName) : this._cacheDir;
                var filePath = this._path.join(dir, cacheKey + '.mp3');
                if (this._fs.existsSync(filePath)) {
                    this._fs.unlinkSync(filePath);
                    if (window._ccvaDebug) console.log('[CC-VA] Deleted cache file: ' + filePath);
                }
            } catch (e) {
                console.error('[CC-VA] Cache delete error:', e);
            }
        },

        getCacheSize: function () {
            if (!this._ready) return 0;
            var self = this;
            var count = 0;
            try {
                var entries = this._fs.readdirSync(this._cacheDir, { withFileTypes: true });
                for (var i = 0; i < entries.length; i++) {
                    if (entries[i].isDirectory()) {
                        var sub = self._fs.readdirSync(self._path.join(self._cacheDir, entries[i].name));
                        for (var j = 0; j < sub.length; j++) {
                            if (sub[j].endsWith('.mp3')) count++;
                        }
                    } else if (entries[i].name.endsWith('.mp3')) {
                        count++; // legacy flat files still counted
                    }
                }
            } catch (e) { }
            return count;
        }
    };

    // ---- UI Dialog Overlay System ----
    window._ccvaUI = {
        _overlay: null,
        _modal: null,
        _title: null,
        _input: null,
        _btnContainer: null,

        init: function () {
            if (this._overlay) return;
            if (typeof document === 'undefined') return;

            var styleId = 'ccva-ui-style';
            if (!document.getElementById(styleId)) {
                var style = document.createElement('style');
                style.id = styleId;
                style.innerHTML = 
                    "#ccva-ui-bg { display:none; position:fixed; top:0; left:0; width:100%; height:100%; " +
                    "background:rgba(0,0,0,0.6); z-index:9999999; justify-content:center; align-items:center; } " +
                    "#ccva-ui-modal { background:linear-gradient(to bottom, #2a2a2a 0%, #1a1a1a 100%); " +
                    "color:#fff; padding:20px; border:2px solid #586884; border-radius:4px; " +
                    "font-family:'Consolas', 'Courier New', monospace; font-size:14px; min-width:350px; " +
                    "box-shadow: 0px 5px 15px rgba(0,0,0,0.8), inset 0px 0px 10px rgba(0,168,243,0.3); } " +
                    "#ccva-ui-title { font-weight:bold; margin-bottom:15px; color:#00a8f3; font-size:16px; white-space:pre-wrap; } " +
                    "#ccva-ui-input { width:100%; background:#111; color:#fff; border:1px solid #555; " +
                    "padding:8px; margin-bottom:15px; font-family:inherit; outline:none; box-sizing:border-box; } " +
                    "#ccva-ui-input:focus { border-color:#00a8f3; box-shadow:0px 0px 5px rgba(0,168,243,0.5); } " +
                    "#ccva-ui-btns { display:flex; justify-content:flex-end; gap:10px; } " +
                    ".ccva-ui-btn { background:linear-gradient(to bottom, #444 0%, #222 100%); border:1px solid #777; " +
                    "color:#fff; font-family:inherit; font-size:13px; font-weight:bold; padding:6px 15px; " +
                    "cursor:pointer; text-shadow:1px 1px 0px #000; border-radius:2px; transition:all 0.1s; } " +
                    ".ccva-ui-btn:hover { background:linear-gradient(to bottom, #00a8f3 0%, #0077b3 100%); border-color:#fff; } " +
                    ".ccva-ui-btn:active { background:linear-gradient(to bottom, #0077b3 0%, #005a8a 100%); }";
                document.head.appendChild(style);
            }

            var bg = document.createElement('div');
            bg.id = 'ccva-ui-bg';
            
            var modal = document.createElement('div');
            modal.id = 'ccva-ui-modal';
            
            var title = document.createElement('div');
            title.id = 'ccva-ui-title';
            
            var input = document.createElement('input');
            input.id = 'ccva-ui-input';
            input.type = 'text';

            var stopPropagation = function(e) { e.stopPropagation(); };
            input.addEventListener('keydown', stopPropagation);
            input.addEventListener('keyup', stopPropagation);
            input.addEventListener('keypress', stopPropagation);
            
            var btns = document.createElement('div');
            btns.id = 'ccva-ui-btns';
            
            modal.appendChild(title);
            modal.appendChild(input);
            modal.appendChild(btns);
            bg.appendChild(modal);

            if (document.body) { document.body.appendChild(bg); }

            this._overlay = bg;
            this._modal = modal;
            this._title = title;
            this._input = input;
            this._btnContainer = btns;
        },

        _show: function (titleText, isPrompt, defaultVal, callback) {
            this.init();
            if (!this._overlay) {
                if (isPrompt) {
                    var r = prompt(titleText, defaultVal || "");
                    if (callback) callback(r);
                } else {
                    var c = confirm(titleText);
                    if (callback) callback(c ? true : false);
                }
                return;
            }

            this._title.innerText = titleText;
            this._btnContainer.innerHTML = '';
            
            var self = this;
            var cleanup = function() {
                self._overlay.style.display = 'none';
                if (window.ig && window.ig.input) window.ig.input.clearPressed();
            };

            var btnOk = document.createElement('button');
            btnOk.className = 'ccva-ui-btn';
            btnOk.innerText = 'OK';
            
            var btnCancel = document.createElement('button');
            btnCancel.className = 'ccva-ui-btn';
            btnCancel.innerText = 'Cancel';

            if (isPrompt) {
                this._input.style.display = 'block';
                this._input.value = defaultVal || '';
            } else {
                this._input.style.display = 'none';
            }

            var submit = function() {
                cleanup();
                if (callback) callback(isPrompt ? self._input.value : true);
            };

            var cancel = function() {
                cleanup();
                if (callback) callback(isPrompt ? null : false);
            };

            btnOk.onclick = submit;
            btnCancel.onclick = cancel;

            this._input.onkeydown = function(e) {
                e.stopPropagation();
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape') cancel();
            };

            this._btnContainer.appendChild(btnCancel);
            this._btnContainer.appendChild(btnOk);

            this._overlay.style.display = 'flex';
            
            if (isPrompt) {
                setTimeout(function() { 
                    self._input.focus(); 
                    self._input.select();
                }, 10);
            }
        },

        prompt: function (message, defaultValue, callback) {
            this._show(message, true, defaultValue, callback);
        },

        confirm: function (message, callback) {
            this._show(message, false, null, callback);
        }
    };

    // ---- Voice Acting Controller ----
    window.ccVoiceActing = {
        config: null,
        _initialized: false,
        _tts: VA_TTS_CLIENT,
        _audio: VA_AUDIO_MANAGER,
        _cache: VA_CACHE_MANAGER,

        // Sequence counter: incremented on every new speak call.
        // Async TTS results only play if their sequence matches the current one.
        _speakSeq: 0,
        _lastSpeakTime: 0,

        init: function () {
            var self = this;

            try {
                var fs = require('fs');
                var path = require('path');
                var gameRoot = path.resolve('.');

                // First-run: deploy template mod-data (includes voice-config.json + portraits)
                var modDataTarget = path.join(gameRoot, 'assets', 'mod-data', 'cc-ava');
                if (!fs.existsSync(modDataTarget)) {
                    var templateSource = path.join(gameRoot, 'assets', 'mods', 'cc-ava', 'templates', 'mod-data', 'cc-ava');
                    if (fs.existsSync(templateSource)) {
                        self._copyDirRecursive(fs, path, templateSource, modDataTarget);
                        console.log('[CC-VA] First run: deployed mod-data template to ' + modDataTarget);
                    }
                }

                // Load config from mod-data (writable, persists across mod updates)
                var configPath = path.join(gameRoot, 'assets', 'mod-data', 'cc-ava', 'voice-config.json');
                var configText = fs.readFileSync(configPath, 'utf-8');
                self.config = JSON.parse(configText);

                self._audio.init(self.config.volume || 0.8);
                self._cache.init();
                self._initialized = true;

                var configuredVoices = Object.keys(self.config.voices).filter(function (k) {
                    return self.config.voices[k].voiceId && self.config.voices[k].voiceId.length > 0;
                });
                if (window._ccvaDebug) console.log('[CC-VA] Config loaded. Voices: ' + configuredVoices.length +
                    ', On-demand: ' + self.config.generateOnDemand +
                    ', Cache: ' + self._cache.getCacheSize());

                return Promise.resolve();
            } catch (e) {
                console.error('[CC-VA] Failed to load config:', e);
                return Promise.reject(e);
            }
        },

        // Recursively copy a directory tree (used for first-run template deployment)
        _copyDirRecursive: function (fs, path, src, dest) {
            if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
            var entries = fs.readdirSync(src, { withFileTypes: true });
            for (var i = 0; i < entries.length; i++) {
                var srcPath = path.join(src, entries[i].name);
                var destPath = path.join(dest, entries[i].name);
                if (entries[i].isDirectory()) {
                    this._copyDirRecursive(fs, path, srcPath, destPath);
                } else {
                    fs.copyFileSync(srcPath, destPath);
                }
            }
        },

        // Detect cutscene skip: dialog fires faster than 50ms apart = fast-forwarding
        _isSkipping: function () {
            var now = Date.now();
            var elapsed = now - this._lastSpeakTime;
            this._lastSpeakTime = now;
            return elapsed < 50;
        },

        _resolveVoice: function (charName) {
            var voiceEntry = this.config.voices[charName];
            if (voiceEntry && voiceEntry.enabled && voiceEntry.voiceId) {
                return voiceEntry.voiceId;
            }
            return this.config.defaultVoice || null;
        },

        _prepareSpeak: function (charName, rawText) {
            if (!this._initialized || !this.config || !this.config.enabled) return null;
            var text = this._tts.cleanText(rawText, this.config.pronunciations, this.config.model);
            if (!text) return null;
            if (this._tts.shouldSkip(text, this.config.skipPatterns)) return null;

            var originalText = text;
            if (this.config.model === 'eleven_v3' && this.config.transcriptionOverrides && this.config.transcriptionOverrides[originalText]) {
                text = this.config.transcriptionOverrides[originalText];
            }

            // Apply speaker-based text prefixes (e.g. "[shad accent] " for baki NPCs)
            // Only on v3 model, and skip if text already starts with a bracket tag
            if (this.config.model === 'eleven_v3' && this.config.speakerPrefixes && charName) {
                var prefixKeys = Object.keys(this.config.speakerPrefixes);
                for (var pi = 0; pi < prefixKeys.length; pi++) {
                    if (charName.toLowerCase().indexOf(prefixKeys[pi].toLowerCase()) !== -1) {
                        // Don't double-tag: skip if text already starts with a bracket directive
                        if (!/^\[/.test(text)) {
                            text = this.config.speakerPrefixes[prefixKeys[pi]] + text;
                            if (window._ccvaDebug) {
                                console.log('[CC-VA] Applied speaker prefix "' + prefixKeys[pi] + '" -> "' + text.substring(0, 60) + '..."');
                            }
                        }
                        break;
                    }
                }
            }

            var voiceId = this._resolveVoice(charName) || "";

            var pitch = 1.0;
            if (this.config.voices && this.config.voices[charName] && this.config.voices[charName].pitch !== undefined) {
                pitch = this.config.voices[charName].pitch;
            }

            var voiceVolume = 100;
            if (this.config.voices && this.config.voices[charName] && this.config.voices[charName].volume !== undefined) {
                voiceVolume = this.config.voices[charName].volume;
            }

            return { text: text, originalText: originalText, voiceId: voiceId, charName: charName, pitch: pitch, volume: voiceVolume };
        },

        _playEntry: function (entry) {
            var self = this;
            var charName = entry.charName;

            this._lastEntry = entry;
            if (window._ccvaDebug) this._updateDebugOverlay(entry);

            if (!entry.voiceId) return Promise.resolve();

            var cacheKey = this._tts.getCacheKey(entry.originalText, entry.voiceId);

            if (this._cache.has(cacheKey, charName)) {
                var cachedAudio = this._cache.get(cacheKey, charName);
                if (cachedAudio) {
                    if (window._ccvaDebug) {
                        console.log('[CC-VA] Playing cached: [' + charName + '] ' + cacheKey + '.mp3 -> "' + entry.text.substring(0, 40) + '..."');
                    }
                    return this._audio.play(cachedAudio, entry.pitch, entry.volume);
                }
            }

            if (!this.config.generateOnDemand) return Promise.resolve();
            if (!this.config.apiKey || this.config.apiKey === 'YOUR_ELEVENLABS_API_KEY') return Promise.resolve();

            if (window._ccvaDebug) {
                console.log('[CC-VA] Generating on-demand TTS: [' + charName + '] ' + cacheKey + '.mp3 -> "' + entry.text.substring(0, 40) + '..."');
            }

            var mySeq = self._speakSeq;
            return this._tts.generateSpeech(entry.text, entry.voiceId, this.config.apiKey, this.config.model)
                .then(function (audioData) {
                    self._cache.set(cacheKey, charName, audioData, entry.text);
                    // Only play if no newer speak call has happened
                    if (self._speakSeq !== mySeq) {
                        if (window._ccvaDebug) console.log('[CC-VA] Discarding stale TTS result (seq ' + mySeq + ' != ' + self._speakSeq + ')');
                        return;
                    }
                    return self._audio.play(audioData, entry.pitch, entry.volume);
                })
                .catch(function (err) {
                    console.error('[CC-VA] TTS error:', err.message || err);
                });
        },

        // For cutscene dialog (SHOW_MSG) - interrupts previous
        speak: function (charName, rawText) {
            this._speakSeq++;
            if (this._isSkipping()) {
                this._audio.stop();
                return;
            }
            var entry = this._prepareSpeak(charName, rawText);
            if (!entry) return;
            this._audio.stop();
            this._playEntry(entry);
        },

        // Speak a side message directly (called from showNextSideMessage with what's actually on screen)
        speakSideMessage: function (charExpression, message) {
            this._speakSeq++;
            try {
                var charName = 'unknown';
                if (charExpression && charExpression.character) {
                    charName = charExpression.character.name;
                }
                var rawText = message ? message.toString() : '';
                if (!rawText) return;
                var entry = this._prepareSpeak(charName, rawText);
                if (!entry) return;
                this._audio.stop();
                this._playEntry(entry);
            } catch (e) { }
        },

        isVoiceActive: function () {
            return this._audio._playing;
        },

        stopSpeaking: function () {
            this._speakSeq++;
            this._audio.stop();
        },

        // Look-ahead pre-caching: peek at _nextStep and silently generate TTS in background
        _prefetchNext: function (eventStep) {
            if (!this._initialized || !this.config || !this.config.generateOnDemand) return;
            if (!this.config.apiKey || this.config.apiKey === 'YOUR_ELEVENLABS_API_KEY') return;

            try {
                var next = eventStep._nextStep;
                if (!next) return;

                // Only pre-fetch SHOW_MSG or SHOW_SIDE_MSG steps
                if (!(next instanceof ig.EVENT_STEP.SHOW_MSG) &&
                    !(next instanceof ig.EVENT_STEP.SHOW_SIDE_MSG)) return;

                var charName = 'unknown';
                if (next.charExpression && next.charExpression.character) {
                    charName = next.charExpression.character.name;
                } else if (next.person && next.person.person) {
                    charName = next.person.person;
                }

                var rawText = next.message ? next.message.toString() : '';
                if (!rawText) return;

                var entry = this._prepareSpeak(charName, rawText);
                if (!entry || !entry.voiceId) return;

                var cacheKey = this._tts.getCacheKey(entry.originalText, entry.voiceId);
                // Already cached — nothing to do
                if (this._cache.has(cacheKey, entry.charName)) return;

                if (window._ccvaDebug) {
                    console.log('[CC-VA] Pre-fetching next: [' + charName + '] "' + entry.text.substring(0, 40) + '..."');
                }

                var self = this;
                this._tts.generateSpeech(entry.text, entry.voiceId, this.config.apiKey, this.config.model)
                    .then(function (audioData) {
                        self._cache.set(cacheKey, entry.charName, audioData, entry.text);
                        if (window._ccvaDebug) {
                            console.log('[CC-VA] Pre-cached: [' + charName + '] ' + cacheKey + '.mp3');
                        }
                    })
                    .catch(function (err) {
                        // Silent failure — pre-fetch is best-effort
                        if (window._ccvaDebug) {
                            console.log('[CC-VA] Pre-fetch failed: ' + (err.message || err));
                        }
                    });
            } catch (e) {
                // Never let pre-fetch errors interrupt gameplay
            }
        },

        _updateDebugOverlay: function (entry) {
            if (!this._debugOverlay) {
                if (!document.getElementById('ccva-debug-style')) {
                    var style = document.createElement('style');
                    style.id = 'ccva-debug-style';
                    style.innerHTML = 
                        "#ccva-debug-overlay { position:absolute; bottom:10px; right:10px; z-index:999999; " +
                        "background:linear-gradient(to bottom, #2a2a2a 0%, #1a1a1a 100%); color:#fff; padding:12px 18px; border:2px solid #586884; border-radius:4px; " +
                        "font-family:'Consolas', 'Courier New', monospace; font-size:13px; font-weight:bold; " +
                        "box-shadow:0px 5px 15px rgba(0,0,0,0.8), inset 0px 0px 10px rgba(0,168,243,0.3); text-shadow:1px 1px 0px #000; display:none; } " +
                        ".ccva-btn { background:linear-gradient(to bottom, #444 0%, #222 100%); border:1px solid #777; " +
                        "color:#fff; font-family:'Consolas', 'Courier New', monospace; font-size:12px; font-weight:bold; " +
                        "padding:6px 15px; margin-right:8px; cursor:pointer; text-shadow:1px 1px 0px #000; border-radius:2px; transition:all 0.1s; } " +
                        ".ccva-btn:hover { background:linear-gradient(to bottom, #00a8f3 0%, #0077b3 100%); border-color:#fff; box-shadow:0px 0px 5px rgba(0,168,243,0.5); } " +
                        ".ccva-btn:active { background:linear-gradient(to bottom, #0077b3 0%, #005a8a 100%); border-color:#fff; }";
                    document.head.appendChild(style);
                }

                var div = document.createElement('div');
                div.id = 'ccva-debug-overlay';

                var btnRegen = document.createElement('button');
                btnRegen.className = 'ccva-btn';
                btnRegen.innerText = 'Regenerate Line';
                
                var btnEdit = document.createElement('button');
                btnEdit.className = 'ccva-btn';
                btnEdit.innerText = 'Edit TTS Text';

                var btnAssign = document.createElement('button');
                btnAssign.className = 'ccva-btn';
                btnAssign.innerText = 'Set Voice ID';

                var label = document.createElement('div');
                label.style.marginBottom = '8px';
                label.innerText = 'Last Line: None';
                
                var btnClose = document.createElement('button');
                btnClose.className = 'ccva-btn';
                btnClose.innerText = 'Close';
                btnClose.onclick = function() { div.style.display = 'none'; };

                div.appendChild(label);
                div.appendChild(btnRegen);
                div.appendChild(btnEdit);
                div.appendChild(btnAssign);
                div.appendChild(btnClose);
                
                // Mount to nw.js document
                if (document.body) {
                    document.body.appendChild(div);
                }

                this._debugOverlay = div;
                this._debugLabel = label;

                var self = this;
                btnRegen.onclick = function() { self._regenerateLast(false); };
                btnEdit.onclick = function() { self._regenerateLast(true); };
                btnAssign.onclick = function() { self._assignVoiceId(); };
            }

            this._debugOverlay.style.display = 'block';
            var trunc = entry.originalText.length > 50 ? entry.originalText.substring(0, 50) + '...' : entry.originalText;
            this._debugLabel.innerText = 'Last Line: [' + entry.charName + '] ' + trunc;
        },

        _assignVoiceId: function () {
            if (!this._lastEntry || !this.config.voices) return;
            var entry = this._lastEntry;
            var charName = entry.charName;
            var self = this;
            
            var assignPrompt = function() {
                var currentId = self.config.voices[charName].voiceId || "";
                window._ccvaUI.prompt("Enter ElevenLabs Voice ID for '" + charName + "':\n(Leave blank to clear)", currentId, function(newId) {
                    if (newId === null) return; // cancelled
                    
                    var currentPitch = (typeof self.config.voices[charName].pitch === "number" ? self.config.voices[charName].pitch : 1.0).toString();
                    window._ccvaUI.prompt("Enter Pitch Multiplier for '" + charName + "' (e.g. 1.0, 0.85, 1.25):", currentPitch, function(newPitch) {
                        if (newPitch === null) return;
                        
                        var parsedPitch = parseFloat(newPitch);
                        if (!isNaN(parsedPitch) && parsedPitch > 0) {
                            self.config.voices[charName].pitch = parsedPitch;
                            entry.pitch = parsedPitch;
                        }

                        var currentVol = (typeof self.config.voices[charName].volume === "number" ? self.config.voices[charName].volume : 100).toString();
                        window._ccvaUI.prompt("Enter Volume for '" + charName + "' (0-100):", currentVol, function(newVol) {
                            if (newVol === null) return;

                            var parsedVol = parseInt(newVol, 10);
                            if (!isNaN(parsedVol) && parsedVol >= 0 && parsedVol <= 100) {
                                self.config.voices[charName].volume = parsedVol;
                                entry.volume = parsedVol;
                            }

                            newId = newId.trim();
                            self.config.voices[charName].voiceId = newId;
                            self.config.voices[charName].enabled = true;
                            entry.voiceId = newId;
                            
                            try {
                                var fs = require('fs');
                                var path = require('path');
                                var gameRoot = path.resolve('.');
                                var configPath = path.join(gameRoot, 'assets', 'mod-data', 'cc-ava', 'voice-config.json');
                                fs.writeFileSync(configPath, JSON.stringify(self.config, null, 4), 'utf-8');
                                
                                if (window.modmanager && window.modmanager.options && window.modmanager.options["cc-ava"]) {
                                    window.modmanager.options["cc-ava"]["va-" + charName + "-id"] = newId;
                                }
                                
                                console.log('[CC-VA] Saved Voice config for ' + charName + ': ID=' + newId + ', Pitch=' + (self.config.voices[charName].pitch || 1.0) + ', Vol=' + (self.config.voices[charName].volume || 100));
                            } catch (e) {
                                console.error('[CC-VA] Failed to save config:', e);
                            }
                            
                            // Auto-regenerate and play to preview immediately
                            if (newId) {
                                self._regenerateLast(false);
                            }
                        });
                    });
                });
            };
            
            if (!this.config.voices[charName]) {
                window._ccvaUI.confirm("Character '" + charName + "' is not currently recognized in the mod configuration. Add them as a trackable entity?", function(addIt) {
                    if (!addIt) return;
                    self.config.voices[charName] = { enabled: true, label: charName, pitch: 1, volume: 100 };
                    assignPrompt();
                });
            } else {
                assignPrompt();
            }
        },

        _regenerateLast: function (withEdit) {
            if (!this._lastEntry || !this.config.generateOnDemand || !this.config.apiKey) return;
            var self = this;
            var entry = this._lastEntry;
            
            if (!entry.voiceId) {
                console.log("[CC-VA] Regeneration aborted: No Voice ID assigned for " + entry.charName);
                return;
            }
            
            var proceedGen = function(textToGen) {
                var cacheKey = self._tts.getCacheKey(entry.originalText, entry.voiceId);
                self._cache.delete(cacheKey, entry.charName);
                
                console.log('[CC-VA] Regenerating TTS: ' + cacheKey + '.mp3 -> "' + textToGen + '"');
                self._tts.generateSpeech(textToGen, entry.voiceId, self.config.apiKey, self.config.model)
                    .then(function (audioData) {
                        self._cache.set(cacheKey, entry.charName, audioData, textToGen);
                        self._audio.play(audioData, entry.pitch, entry.volume);
                    })
                    .catch(function (err) {
                        console.error('[CC-VA] TTS Regeneration error:', err.message || err);
                    });
            };
            
            if (withEdit) {
                window._ccvaUI.prompt("Edit text specifically for ElevenLabs generation (This natively overwrites what it sends for this exact line):", entry.text, function(newText) {
                    if (newText === null) return; // cancelled
                    var textToGen = newText.trim();
                    
                    // Save to json
                    if (!self.config.transcriptionOverrides) self.config.transcriptionOverrides = {};
                    self.config.transcriptionOverrides[entry.originalText] = textToGen;
                    
                    try {
                        var fs = require('fs');
                        var path = require('path');
                        var gameRoot = path.resolve('.');
                        var configPath = path.join(gameRoot, 'assets', 'mod-data', 'cc-ava', 'voice-config.json');
                        fs.writeFileSync(configPath, JSON.stringify(self.config, null, 4), 'utf-8');
                        console.log('[CC-VA] Saved new transcription override for: "' + entry.originalText + '"');
                    } catch (e) {
                        console.error('[CC-VA] Failed to save transcription override:', e);
                    }
                    
                    proceedGen(textToGen);
                });
            } else {
                proceedGen(entry.text);
            }
        }
    };

    // Initialize immediately (sync)
    window.ccVoiceActing.init();

    // ---- DevTools opener (F12 key) ----
    document.addEventListener('keydown', function (e) {
        if (e.key === 'F12' || e.keyCode === 123) {
            try {
                // nw.js 0.13+
                nw.Window.get().showDevTools();
            } catch (ex) {
                try {
                    // older nw.js
                    require('nw.gui').Window.get().showDevTools();
                } catch (ex2) {
                    if (window._ccvaDebug) console.log('[CC-VA] Could not open DevTools');
                }
            }
        }
    });

    // ---- Hook into CrossCode's event system ----
    ig.module('cc-ava.dialog-hooks')
        .requires(
            'game.feature.msg.msg-steps'
        )
        .defines(function () {

            // SHOW_SIDE_MSG: no hook needed — voice is triggered directly
            // from showNextSideMessage which reads what's actually on screen

            // ---- Hook SHOW_MSG ----
            if (ig.EVENT_STEP.SHOW_MSG) {
                ig.EVENT_STEP.SHOW_MSG.inject({
                    start: function () {
                        this.parent();
                        try {
                            var charName = 'unknown';
                            if (this.charExpression && this.charExpression.character) {
                                charName = this.charExpression.character.name;
                            } else if (this.person && this.person.person) {
                                charName = this.person.person;
                            }
                            var text = this.message ? this.message.toString() : '';
                            if (text) window.ccVoiceActing.speak(charName, text);
                        } catch (e) { }
                        // Look-ahead: pre-generate next dialog line in background
                        try { window.ccVoiceActing._prefetchNext(this); } catch (e) { }
                    }
                });
            }

            // ---- Hook CLEAR_MSG / CLEAR_SIDE_MSG ----
            if (ig.EVENT_STEP.CLEAR_MSG) {
                ig.EVENT_STEP.CLEAR_MSG.inject({
                    start: function () {
                        window.ccVoiceActing.stopSpeaking();
                        this.parent();
                    }
                });
            }
            if (ig.EVENT_STEP.CLEAR_SIDE_MSG) {
                ig.EVENT_STEP.CLEAR_SIDE_MSG.inject({
                    start: function () {
                        window.ccVoiceActing.stopSpeaking();
                        this.parent();
                    }
                });
            }

            if (window._ccvaDebug) console.log('[CC-VA] Dialog hooks installed');

            // ---- Stop voice on cutscene skip ----
            if (sc.GameModel) {
                sc.GameModel.inject({
                    skipCutscene: function () {
                        if (window.ccVoiceActing) {
                            window.ccVoiceActing.stopSpeaking();
                        }
                        this.parent();
                    }
                });
            }
        });

    // ---- Hook side message HUD for voice sync ----
    ig.module('cc-ava.side-msg-pacer')
        .requires(
            'game.feature.msg.gui.side-message-hud'
        )
        .defines(function () {

            if (sc.SideMessageHudGui) {
                sc.SideMessageHudGui.inject({

                    // When a side message actually displays, speak what's on screen
                    showNextSideMessage: function () {
                        // Peek at what the game is about to display (sideMessageStack is shifted by getNextSideMessage inside parent)
                        var msgData = null;
                        try { msgData = sc.model.message.sideMessageStack[0]; } catch (e) { }
                        this.parent();
                        // Speak the message that just appeared
                        if (msgData && window.ccVoiceActing) {
                            window.ccVoiceActing.speakSideMessage(msgData.charExpression, msgData.message);
                        }
                    },

                    // Prevent advancing to the next message while voice is playing
                    doMessageStep: function (b) {
                        if (window.ccVoiceActing && window.ccVoiceActing.isVoiceActive()) {
                            this.timer = 0.1; // keep checking
                            return;
                        }
                        this.parent(b);
                    },

                    // Freeze the dismiss timer while voice is playing
                    update: function () {
                        if (window.ccVoiceActing && window.ccVoiceActing.isVoiceActive() && !this.pauseMode && this.timer > 0) {
                            return; // don't tick timer
                        }
                        this.parent();
                    },

                    // Let user skip voice with the skip button
                    onSkipInteract: function (b) {
                        if (window.ccVoiceActing && window.ccVoiceActing.isVoiceActive() && b === sc.SKIP_INTERACT_MSG.SKIPPED) {
                            window.ccVoiceActing.stopSpeaking();
                        }
                        this.parent(b);
                    }
                });
                if (window._ccvaDebug) console.log('[CC-VA] Side message pacer installed');
            }
        });

})();
