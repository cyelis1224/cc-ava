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

        cleanText: function (text, pronunciations) {
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
            // Remove action/emote tags: [nods], [shakes head], [sighs], etc. (but preserve numbers like [1], [4])
            cleaned = cleaned.replace(/\[[a-zA-Z][^\]]*\]/g, '');
            // Apply pronunciation corrections (word-boundary replacements)
            if (pronunciations) {
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

        play: function (audioData, pitch) {
            var self = this;
            this.stop();
            if (!this._audioContext) return Promise.reject(new Error('No AudioContext'));
            if (this._audioContext.state === 'suspended') this._audioContext.resume();

            return this._audioContext.decodeAudioData(audioData.slice(0))
                .then(function (audioBuffer) {
                    var source = self._audioContext.createBufferSource();
                    source.buffer = audioBuffer;
                    if (pitch !== undefined && pitch !== 1.0) {
                        source.playbackRate.value = pitch;
                    }

                    // Per-clip gain node for fade-out to prevent end-of-clip clipping
                    var clipGain = self._audioContext.createGain();
                    clipGain.gain.value = 1.0;
                    var fadeOutDuration = 0.075; // 75ms fade-out
                    var fadeOutStart = Math.max(0, audioBuffer.duration - fadeOutDuration);
                    var now = self._audioContext.currentTime;
                    clipGain.gain.setValueAtTime(1.0, now + fadeOutStart);
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

    // ---- Voice Acting Controller ----
    window.ccVoiceActing = {
        config: null,
        _initialized: false,
        _tts: VA_TTS_CLIENT,
        _audio: VA_AUDIO_MANAGER,
        _cache: VA_CACHE_MANAGER,

        // Pre-loaded queue: SHOW_SIDE_MSG events push data here,
        // showNextSideMessage pops and plays at the right display timing
        _sideMsgPending: [],
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
            var text = this._tts.cleanText(rawText, this.config.pronunciations);
            if (!text) return null;
            if (this._tts.shouldSkip(text, this.config.skipPatterns)) return null;

            var voiceId = this._resolveVoice(charName);
            if (!voiceId) return null;

            var pitch = 1.0;
            if (this.config.voices[charName] && this.config.voices[charName].pitch !== undefined) {
                pitch = this.config.voices[charName].pitch;
            }

            return { text: text, voiceId: voiceId, charName: charName, pitch: pitch };
        },

        _playEntry: function (entry) {
            var self = this;
            var cacheKey = this._tts.getCacheKey(entry.text, entry.voiceId);
            var charName = entry.charName;

            if (this._cache.has(cacheKey, charName)) {
                var cachedAudio = this._cache.get(cacheKey, charName);
                if (cachedAudio) {
                    if (window._ccvaDebug) {
                        console.log('[CC-VA] Playing cached: [' + charName + '] ' + cacheKey + '.mp3 -> "' + entry.text.substring(0, 40) + '..."');
                    }
                    return this._audio.play(cachedAudio, entry.pitch);
                }
            }

            if (!this.config.generateOnDemand) return Promise.resolve();
            if (!this.config.apiKey || this.config.apiKey === 'YOUR_ELEVENLABS_API_KEY') return Promise.resolve();

            if (window._ccvaDebug) {
                console.log('[CC-VA] Generating on-demand TTS: [' + charName + '] ' + cacheKey + '.mp3 -> "' + entry.text.substring(0, 40) + '..."');
            }

            return this._tts.generateSpeech(entry.text, entry.voiceId, this.config.apiKey, this.config.model)
                .then(function (audioData) {
                    self._cache.set(cacheKey, charName, audioData, entry.text);
                    return self._audio.play(audioData, entry.pitch);
                })
                .catch(function (err) {
                    console.error('[CC-VA] TTS error:', err.message || err);
                });
        },

        // For cutscene dialog (SHOW_MSG) - interrupts previous
        speak: function (charName, rawText) {
            if (this._isSkipping()) {
                this._audio.stop();
                return;
            }
            var entry = this._prepareSpeak(charName, rawText);
            if (!entry) return;
            this._audio.stop();
            this._playEntry(entry);
        },

        // Push side message data into the pre-loaded queue
        pushSideMessage: function (charName, rawText) {
            // No skip detection here — side messages always fire rapidly
            // within the same frame. The queue handles sequential playback.
            var entry = this._prepareSpeak(charName, rawText);
            if (entry) {
                this._sideMsgPending.push(entry);
            }
        },

        // Pop and play the next pre-loaded side message
        playSideMessage: function () {
            if (this._sideMsgPending.length === 0) return;
            var entry = this._sideMsgPending.shift();
            this._audio.stop();
            this._playEntry(entry);
        },

        isVoiceActive: function () {
            return this._audio._playing;
        },

        stopSpeaking: function () {
            this._sideMsgPending = [];
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
                if (!entry) return;

                var cacheKey = this._tts.getCacheKey(entry.text, entry.voiceId);
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

            // ---- Hook SHOW_SIDE_MSG ----
            // Pre-load voice data into the queue. Voice is played later
            // when showNextSideMessage actually displays the message.
            if (ig.EVENT_STEP.SHOW_SIDE_MSG) {
                ig.EVENT_STEP.SHOW_SIDE_MSG.inject({
                    start: function () {
                        // Push voice data BEFORE parent() because parent() synchronously
                        // triggers: showSideMessage → modelChanged → showNextSideMessage → playSideMessage
                        // The queue entry must exist before that chain fires.
                        try {
                            var charName = (this.charExpression && this.charExpression.character)
                                ? this.charExpression.character.name : 'unknown';
                            var text = this.message ? this.message.toString() : '';
                            if (text) {
                                window.ccVoiceActing.pushSideMessage(charName, text);
                            }
                        } catch (e) { }
                        this.parent();
                        // Look-ahead: pre-generate next dialog line in background
                        try { window.ccVoiceActing._prefetchNext(this); } catch (e) { }
                    }
                });
            }

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
        });

    // ---- Hook side message HUD for voice sync ----
    ig.module('cc-ava.side-msg-pacer')
        .requires(
            'game.feature.msg.gui.side-message-hud'
        )
        .defines(function () {

            if (sc.SideMessageHudGui) {
                sc.SideMessageHudGui.inject({

                    // When a side message actually displays, play its pre-loaded voice
                    showNextSideMessage: function () {
                        this.parent();
                        try {
                            window.ccVoiceActing.playSideMessage();
                        } catch (e) { }
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
