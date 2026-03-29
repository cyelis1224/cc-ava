// ============================================================
// cc-ava: Post-start
// ============================================================
// Generates the massive Voice Configuration list dynamically 
// inside the official CCModManager Settings Menu!
// ============================================================

ig.module('cc-ava.poststart')
    .requires(
        'game.feature.model.options-model',
        'game.feature.menu.gui.options.options-types'
    )
    .defines(function () {
        console.log('[CC-VA] Setting up CCModManager configurations natively...');

        var fs = require('fs');
        var path = require('path');
        var CONFIG_PATH = path.join(process.cwd(), 'assets', 'mod-data', 'cc-ava', 'voice-config.json');

        // Cache object
        var configData = { voices: {} };
        try {
            configData = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        } catch (e) {
            console.error("[CC-VA] Failed to load voice config:", e);
        }

        // Simple global debug flag - avoids object reference issues
        window._ccvaDebug = !!configData.debug;

        function saveConfig() {
            try {
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(configData, null, 4), 'utf-8');
                if (window.ccVoiceActing) {
                    window.ccVoiceActing.config = configData;
                }
            } catch (e) {
                console.error("[CC-VA] Failed to save config:", e);
            }
        }

        // ==========================================
        // 1. CCModManager Menu Hook (Native Inputs)
        // ==========================================

        var elevenModels = ["eleven_monolingual_v1", "eleven_monolingual_v2", "eleven_v3"];
        var initModelIdx = elevenModels.indexOf(configData.model || "eleven_v3");
        if (initModelIdx < 0) initModelIdx = 2;

        if (window.modmanager && window.modmanager.registerAndGetModOptions) {
            try {
                var customOptions = {
                    "Engine Settings": {
                        settings: { title: "Engine Settings" },
                        headers: {
                            "ElevenLabs Connection": {
                                "va-api-key": {
                                    type: "INPUT_FIELD",
                                    init: configData.apiKey || "",
                                    name: { en_US: "ElevenLabs API Key" },
                                    description: { en_US: "Paste your private ElevenLabs API Key used to generate TTS audio." },
                                    changeEvent: function (val) {
                                        if (val && val.trim().length > 0) {
                                            configData.apiKey = val;
                                            saveConfig();
                                        }
                                    }
                                },
                                "va-api-key-paste": {
                                    type: "BUTTON",
                                    name: { en_US: "Paste Key from Clipboard" },
                                    description: { en_US: "Click to securely paste your ElevenLabs API Key from your clipboard to bypass typing." },
                                    onPress: function () {
                                        try {
                                            var nwClip = require('nw.gui').Clipboard.get();
                                            var text = nwClip.get('text');
                                            if (text && text.trim().length > 0) {
                                                configData.apiKey = text.trim();
                                                saveConfig();
                                                console.log("[CC-VA] Pasted API Key from clipboard: " + text.trim());

                                                if (ig.soundManager && ig.soundManager.sounds) {
                                                    var sd = ig.soundManager.sounds.guiSubmit;
                                                    if (sd) sd.play();
                                                }

                                                // Sync the underlying CCModManager Options state so it doesn't revert
                                                if (window.modmanager && modmanager.options && modmanager.options["cc-ava"]) {
                                                    modmanager.options["cc-ava"]["va-api-key"] = configData.apiKey;
                                                }

                                                // Force exit the menu to naturally trigger a visual refresh on next open
                                                if (sc.menu && sc.menu.currentMenu && sc.menu.currentMenu.popMenu) {
                                                    sc.menu.popMenu();
                                                }

                                            } else {
                                                if (ig.soundManager && ig.soundManager.sounds) {
                                                    var sd2 = ig.soundManager.sounds.guiError;
                                                    if (sd2) sd2.play();
                                                }
                                            }
                                        } catch (e) {
                                            console.error("[CC-VA] Failed to read clipboard:", e);
                                        }
                                    }
                                },
                                "va-model-selection": {
                                    type: "BUTTON_GROUP",
                                    init: initModelIdx,
                                    buttonNames: ["Monolingual V1", "Monolingual V2", "Multilingual V3"],
                                    data: {
                                        "Monolingual V1": 0,
                                        "Monolingual V2": 1,
                                        "Multilingual V3": 2
                                    },
                                    name: { en_US: "AI Model" },
                                    description: { en_US: "Select the ElevenLabs generation model you want to default to." },
                                    changeEvent: function (val) {
                                        if (typeof val === 'number' && elevenModels[val]) {
                                            configData.model = elevenModels[val];
                                            saveConfig();
                                            console.log("[CC-VA] Model changed to:", elevenModels[val]);
                                        }
                                    }
                                }
                            },
                            "Advanced Settings": {
                                "va-debug-mode": {
                                    type: "CHECKBOX",
                                    init: configData.debug || false,
                                    name: { en_US: "Debug Logging" },
                                    description: { en_US: "Enable detailed activity logging in the developer console (shows at the top right)." },
                                    changeEvent: function () {
                                        // CCModManager CHECKBOX passes undefined as val, so read state directly
                                        var isOn = !!(window.modmanager && modmanager.options && modmanager.options["cc-ava"] && modmanager.options["cc-ava"]["va-debug-mode"]);
                                        configData.debug = isOn;
                                        window._ccvaDebug = isOn;
                                        saveConfig();
                                    }
                                }
                            }
                        }
                    }
                };

                var storyTab = { settings: { title: "Story Characters" }, headers: {} };
                var genericTab = { settings: { title: "Generic NPCs" }, headers: {} };

                var storyOrder = [
                    "main.lea", "main.shizuka", "antagonists.gautham", "antagonists.gautham-rl", "antagonists.gautham-rl2",
                    "main.satoshi", "main.sergey", "main.sergey-av", "main.sergey-rl", "main.carla", "main.carla-kid",
                    "main.jet", "main.emilie", "main.apollo", "main.joern", "main.schneider", "main.schneider2",
                    "main.luke", "main.guild-leader", "main.genius", "main.genius-rl", "main.investor", "main.buggy",
                    "main.captain", "main.dkar", "main.glasses", "main.grumpy", "main.lea-clone", "main.manlea", "main.manuela"
                ];

                var allKeys = Object.keys(configData.voices || {});

                // 1. Populate Story Characters
                var storyCount = 0;
                storyOrder.forEach(function (key) {
                    if (configData.voices[key]) {
                        buildCharUI(key, storyTab);
                        storyCount++;
                    }
                });

                // 2. Populate Generic NPCs
                var genericKeys = allKeys.filter(function (key) {
                    return storyOrder.indexOf(key) === -1;
                });

                genericKeys.sort(function (a, b) {
                    var labelA = configData.voices[a].label || a;
                    var labelB = configData.voices[b].label || b;
                    return labelA.localeCompare(labelB);
                });

                genericKeys.forEach(function (key) {
                    buildCharUI(key, genericTab);
                });

                function buildCharUI(key, targetTab) {
                    var v = configData.voices[key];
                    var label = v.label || key;

                    targetTab.headers[label] = {};

                    targetTab.headers[label]["va-" + key + "-id"] = {
                        type: "INPUT_FIELD",
                        init: v.voiceId || "",
                        name: { en_US: "Voice ID" },
                        description: { en_US: "The ElevenLabs unique string ID for this character." },
                        changeEvent: function (val) {
                            configData.voices[key].voiceId = val;
                            saveConfig();
                        }
                    };

                    targetTab.headers[label]["va-" + key + "-pitch"] = {
                        type: "INPUT_FIELD",
                        init: (typeof v.pitch === "number" ? v.pitch : 1.0).toString(),
                        name: { en_US: "Pitch" },
                        description: { en_US: "Playback pitch generic multiplier (e.g. 1.00, 0.85, 1.25)." },
                        changeEvent: function (val) {
                            var parsed = parseFloat(val);
                            if (!isNaN(parsed) && parsed > 0) {
                                configData.voices[key].pitch = parsed;
                                saveConfig();
                            }
                        }
                    };
                }

                // Add custom character tabs to CCModManager options
                customOptions["Story (" + storyCount + ")"] = storyTab;
                customOptions["Generic NPCs (" + genericKeys.length + ")"] = genericTab;

                window.modmanager.registerAndGetModOptions(
                    {
                        modId: "cc-ava",
                        title: "Voice Configuration"
                    },
                    customOptions
                );
            } catch (e) {
                console.error("[CC-VA] ModManager hook failed:", e);
            }
        } else {
            console.log('[CC-VA] CCModManager not found. Mod configuration UI will be hidden.');
        }

        // ==========================================
        // 2. Vanilla Audio Options Hook (Volume Slider)
        // ==========================================

        var voiceVolumeConfig = {
            type: 'ARRAY_SLIDER',
            data: [0, 1],
            init: 1.0,
            cat: sc.OPTION_CATEGORY.GENERAL,
            hasDivider: false,
            fill: true
        };

        var langLabels = ig.lang.labels;
        if (langLabels && langLabels.sc && langLabels.sc.gui) {
            if (!langLabels.sc.gui.options['voice-volume']) langLabels.sc.gui.options['voice-volume'] = {};
            langLabels.sc.gui.options['voice-volume'].name = 'Voice Volume';
            langLabels.sc.gui.options['voice-volume'].description = 'Adjusts the volume of AI-generated voice acting.';
        }

        // Rebuild sc.OPTIONS_DEFINITION sequentially to correctly place the slider under sound volume
        var oldOptions = sc.OPTIONS_DEFINITION;
        sc.OPTIONS_DEFINITION = {};
        for (var key in oldOptions) {
            sc.OPTIONS_DEFINITION[key] = oldOptions[key];
            if (key === 'volume-sound') {
                sc.OPTIONS_DEFINITION['voice-volume'] = voiceVolumeConfig;
            }
        }

        // Fallback injection if the loop above failed to find the exact key name
        if (!sc.OPTIONS_DEFINITION['voice-volume']) {
            sc.OPTIONS_DEFINITION['voice-volume'] = voiceVolumeConfig;
        }

        sc.Model.addObserver(sc.options, {
            modelChanged: function (model, event) {
                if (event === sc.OPTIONS_EVENT.OPTION_CHANGED) {
                    var vol = sc.options.get('voice-volume');
                    if (vol !== undefined && window.ccVoiceActing) {
                        window.ccVoiceActing._audio.setVolume(vol);
                        if (window._ccvaDebug) console.log('[CC-VA] Voice volume set to: ' + Math.round(vol * 100) + '%');
                    }
                }
            }
        });

        var savedVol = sc.options.get('voice-volume');
        if (savedVol !== undefined && window.ccVoiceActing && typeof savedVol === 'number') {
            window.ccVoiceActing._audio.setVolume(savedVol);
            if (window._ccvaDebug) console.log('[CC-VA] Initial voice volume: ' + Math.round(savedVol * 100) + '%');
        } else if (window.ccVoiceActing) {
            window.ccVoiceActing._audio.setVolume(1.0); // Default to 100% Volume natively
        }

        if (window._ccvaDebug) console.log('[CC-VA] Game fully loaded - artificial voice acting system active!');
    });
