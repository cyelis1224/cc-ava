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

        var configData = { voices: {} };
        if (window.ccVoiceActing && window.ccVoiceActing.config) {
            configData = window.ccVoiceActing.config;
        } else {
            try {
                configData = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            } catch (e) {
                console.error("[CC-VA] Failed to load voice config:", e);
            }
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
                                "va-api-key-edit": {
                                    type: "BUTTON",
                                    name: { en_US: "Set API Key" },
                                    description: { en_US: "Click to securely paste your ElevenLabs API Key via a popup prompt." },
                                    onPress: function () {
                                        var currentKey = configData.apiKey || "";
                                        if (currentKey === "YOUR_ELEVENLABS_API_KEY") currentKey = "";
                                        
                                        window._ccvaUI.prompt("Enter your active ElevenLabs API Key:", currentKey, function(newKey) {
                                            if (newKey === null) return; // User cancelled
                                            
                                            if (newKey.trim().length > 0) {
                                                configData.apiKey = newKey.trim();
                                                saveConfig();
                                                console.log("[CC-VA] Saved new API Key via prompt.");

                                                if (ig.soundManager && ig.soundManager.sounds) {
                                                    var sd = ig.soundManager.sounds.guiSubmit;
                                                    if (sd) sd.play();
                                                }
                                            }
                                        });
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
                                        
                                        if (!isOn && window.ccVoiceActing && window.ccVoiceActing._debugOverlay) {
                                            window.ccVoiceActing._debugOverlay.style.display = 'none';
                                        }
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

                    var currentPitch = typeof v.pitch === "number" ? v.pitch : 1.0;
                    var stateIndicator = v.voiceId ? v.voiceId + " (Pitch: " + currentPitch + ")" : "UNASSIGNED";

                    targetTab.headers[label]["va-" + key + "-configure"] = {
                        type: "BUTTON",
                        name: { en_US: stateIndicator },
                        description: { en_US: "Click to assign a Voice ID and set the pitch multiplier for this character." },
                        onPress: function () {
                            var currentId = configData.voices[key].voiceId || "";
                            window._ccvaUI.prompt("Enter ElevenLabs Voice ID for '" + label + "':\n(Leave blank to clear)", currentId, function(newId) {
                                if (newId === null) return;
                                
                                var currentPitch = (typeof configData.voices[key].pitch === "number" ? configData.voices[key].pitch : 1.0).toString();
                                window._ccvaUI.prompt("Enter Pitch Multiplier for '" + label + "' (e.g. 1.0, 0.85, 1.25):", currentPitch, function(newPitch) {
                                    if (newPitch === null) return;

                                    configData.voices[key].voiceId = newId.trim();
                                    
                                    var parsed = parseFloat(newPitch);
                                    if (!isNaN(parsed) && parsed > 0) {
                                        configData.voices[key].pitch = parsed;
                                    }
                                    
                                    if (newId.trim().length > 0) {
                                        configData.voices[key].enabled = true;
                                    }
                                    
                                    saveConfig();

                                    if (ig.soundManager && ig.soundManager.sounds) {
                                        var sd = ig.soundManager.sounds.guiSubmit;
                                        if (sd) sd.play();
                                    }
                                    
                                    // Force exit the menu to natively refresh the button's custom nametag
                                    if (sc.menu && sc.menu.currentMenu && sc.menu.currentMenu.popMenu) {
                                        sc.menu.popMenu();
                                    }
                                });
                            });
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

                // Sync CCModManager's cached options from config after registration creates the options object
                if (window.modmanager.options && window.modmanager.options["cc-ava"]) {
                    var ccOpt = window.modmanager.options["cc-ava"];
                    ccOpt["va-model-selection"] = initModelIdx;
                    ccOpt["va-debug-mode"] = !!configData.debug;
                }
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
