// Chat Sync Extension v1.0.2
// A complete rewrite using IndexedDB's updatedAt property for change detection

// ==================== CONSTANTS & STATE ====================

const EXTENSION_VERSION = '1.0.2';
let isConsoleLoggingEnabled = new URLSearchParams(window.location.search).get("log") === "true";

// Local metadata tracking
let localMetadata = {
  chats: {},
  settings: {
    lastModified: 0,
    syncedAt: 0
  },
  lastSyncTime: 0
};

// Operation state tracking
let operationState = {
  isImporting: false,
  isExporting: false,
  isPendingSync: false,
  operationQueue: [],
  isProcessingQueue: false,
  lastSyncStatus: null
};

// Configuration options with defaults
let syncConfig = {
  syncMode: 'sync', // 'sync' or 'backup'
  syncInterval: 15, // seconds
  importThreshold: 1, // percentage
  exportThreshold: 10, // percentage
  alertOnSmallerCloud: true
};

// Track last seen updated times
let lastSeenUpdates = {};

// ==================== LOGGING & UTILITIES ====================

// Log to console with type and timestamp
function logToConsole(type, message, data = null) {
  if (!isConsoleLoggingEnabled) return;
  
  // Define log priority levels
  const priorityLevels = {
    error: 1,      // Always log errors - highest priority
    warning: 2,    // Important warnings
    success: 2,    // Success messages for important operations
    upload: 2,     // Important upload events
    download: 2,   // Important download events
    cleanup: 2,    // Deletion operations
    start: 3,      // Start of key operations
    end: 3,        // End of key operations
    info: 4,       // General info
    skip: 5,       // Low priority skips
    visibility: 5, // Visibility events
    active: 5      // Tab activity - lowest priority
  };
  
  // Default to lowest priority (5) if type not defined
  const priority = priorityLevels[type] || 5;
  
  // By default, only show priority 1-3 logs unless debug mode is enabled
  if (!isConsoleLoggingEnabled && priority > 3) return;
  
  const timestamp = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hour12: false});
  const icons = {
    info: "ℹ️",
    success: "✅",
    warning: "⚠️",
    error: "❌",
    start: "🔄",
    end: "🏁",
    upload: "⬆️",
    download: "⬇️",
    cleanup: "🧹",
    snapshot: "📸",
    encrypt: "🔐",
    decrypt: "🔓",
    time: "⏰",
    skip: "⏩",
    visibility: "👁️",
    active: "📱"
  };
  
  const icon = icons[type] || "ℹ️";
  const logMessage = `${icon} ${timestamp} [Chat Sync v${EXTENSION_VERSION}] ${message}`;
  
  switch (type) {
    case "error":
      console.error(logMessage, data);
      break;
    case "warning":
      console.warn(logMessage, data);
      break;
    default:
      console.log(logMessage, data);
  }
}

// Throttle function to limit how often a function can be called
function throttle(func, limit) {
  let lastCall = 0;
  return function(...args) {
    const now = Date.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      return func.apply(this, args);
    }
  };
}

// ==================== INITIALIZATION ====================

// Load AWS SDK
async function loadAwsSdk() {
  return new Promise((resolve, reject) => {
    if (typeof AWS !== "undefined") {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://sdk.amazonaws.com/js/aws-sdk-2.1692.0.min.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// Load JSZip for snapshot functionality
async function loadJSZip() {
  return new Promise((resolve, reject) => {
    if (typeof JSZip !== "undefined") {
      resolve(JSZip);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.5.0/jszip.min.js";
    script.onload = () => resolve(window.JSZip);
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// Initialize extension
async function initializeExtension() {
  logToConsole("info", `Chat Sync Extension v${EXTENSION_VERSION} initializing...`);
  
  // Load AWS SDK
  await loadAwsSdk();
  
  // Create UI elements
  insertSyncButton();
  
  // Load configuration
  loadConfiguration();
  
  // Load local metadata
  await loadLocalMetadata();
  
  // Initialize lastSeenUpdates from current chat states
  await initializeLastSeenUpdates();
  
  // Setup localStorage change listener
  setupLocalStorageChangeListener();
  
  // Check if we should perform initial sync
  if (syncConfig.syncMode === 'sync') {
    queueOperation('initial-sync', syncFromCloud);
  }
  
  // Start periodic check for changes 
  startPeriodicChangeCheck();
  
  // Set up visibility change handler
  setupVisibilityChangeHandler();
  
  // Start regular sync interval
  startSyncInterval();
  
  logToConsole("success", "Chat Sync Extension initialized");
}

// Initialize tracking of last seen updates
async function initializeLastSeenUpdates() {
  try {
    const chats = await getAllChatsFromIndexedDB();
    for (const chat of chats) {
      if (chat.id) {
        const chatHash = await generateChatHash(chat);
        lastSeenUpdates[chat.id] = {
          hash: chatHash,
          timestamp: chat.updatedAt || 0
        };
      }
    }
    // Don't log detailed initialization stats - only errors are important here
    if (isConsoleLoggingEnabled) {
      logToConsole("info", `Initialized tracking for ${Object.keys(lastSeenUpdates).length} chats`);
    }
  } catch (error) {
    logToConsole("error", "Failed to initialize last seen updates", error);
  }
}

// ==================== STORAGE & METADATA MANAGEMENT ====================

// Load configuration from localStorage
function loadConfiguration() {
  syncConfig.syncMode = localStorage.getItem("sync-mode") || 'sync';
  syncConfig.syncInterval = parseInt(localStorage.getItem("backup-interval") || "15");
  syncConfig.importThreshold = parseFloat(localStorage.getItem("import-size-threshold") || "1");
  syncConfig.exportThreshold = parseFloat(localStorage.getItem("export-size-threshold") || "10");
  syncConfig.alertOnSmallerCloud = localStorage.getItem("alert-smaller-cloud") === "true";
  
  // Only log configuration in debug mode
  if (isConsoleLoggingEnabled) {
    logToConsole("info", "Configuration loaded");
  }
}

// Save configuration to localStorage
function saveConfiguration() {
  localStorage.setItem("sync-mode", syncConfig.syncMode);
  localStorage.setItem("backup-interval", syncConfig.syncInterval.toString());
  localStorage.setItem("import-size-threshold", syncConfig.importThreshold.toString());
  localStorage.setItem("export-size-threshold", syncConfig.exportThreshold.toString());
  localStorage.setItem("alert-smaller-cloud", syncConfig.alertOnSmallerCloud.toString());
  
  // Only log configuration in debug mode
  if (isConsoleLoggingEnabled) {
    logToConsole("info", "Configuration saved");
  }
}

// Load metadata from localStorage
async function loadLocalMetadata() {
  try {
    const storedMetadata = localStorage.getItem("chat-sync-metadata");
    if (storedMetadata) {
      localMetadata = JSON.parse(storedMetadata);
      logToConsole("info", "Loaded local metadata", { 
        chatCount: Object.keys(localMetadata.chats).length,
        lastSyncTime: localMetadata.lastSyncTime ? new Date(localMetadata.lastSyncTime).toLocaleString() : 'Never'
      });
    } else {
      // Initialize metadata from existing data
      await initializeMetadataFromExistingData();
    }
  } catch (error) {
    logToConsole("error", "Error loading local metadata", error);
    // Initialize metadata from existing data
    await initializeMetadataFromExistingData();
  }
}

// Initialize metadata by scanning current IndexedDB data
async function initializeMetadataFromExistingData() {
  logToConsole("info", "Initializing metadata from existing data");
  
  // Get all chats from IndexedDB
  const chats = await getAllChatsFromIndexedDB();
  
  // Create initial metadata
  localMetadata = {
    chats: {},
    settings: {
      lastModified: Date.now(),
      syncedAt: 0
    },
    lastSyncTime: 0
  };
  
  // Add each chat to metadata
  for (const chat of chats) {
    const chatId = chat.id;
    localMetadata.chats[chatId] = {
      lastModified: chat.updatedAt || Date.now(),
      syncedAt: 0,
      hash: await generateChatHash(chat)
    };
  }
  
  // Save the new metadata
  saveLocalMetadata();
  
  logToConsole("success", "Initialized metadata from existing data", { 
    chatCount: Object.keys(localMetadata.chats).length 
  });
}

// Save metadata to localStorage
function saveLocalMetadata() {
  localStorage.setItem("chat-sync-metadata", JSON.stringify(localMetadata));
  // No need to log every metadata save - very frequent operation
}

// Update metadata for a specific chat
async function updateChatMetadata(chatId, isLocalUpdate = true) {
  try {
    // Get chat data
    const chat = await getChatFromIndexedDB(chatId);
    if (!chat) return;
    
    // Get new hash
    const newHash = await generateChatHash(chat);
    
    // Update metadata
    if (!localMetadata.chats[chatId]) {
      localMetadata.chats[chatId] = {
        lastModified: chat.updatedAt || Date.now(),
        syncedAt: isLocalUpdate ? 0 : Date.now(),
        hash: newHash
      };
    } else {
      localMetadata.chats[chatId].lastModified = chat.updatedAt || Date.now();
      if (!isLocalUpdate) {
        localMetadata.chats[chatId].syncedAt = Date.now();
      }
      localMetadata.chats[chatId].hash = newHash;
    }
    
    // Save updated metadata
    saveLocalMetadata();
    
    // Log chat metadata updates only in debug mode or reduce verbosity
    if (isConsoleLoggingEnabled) {
      logToConsole("info", `Updated metadata for chat ${chatId.substring(0, 8)}...`);
    }
  } catch (error) {
    logToConsole("error", `Error updating metadata for chat ${chatId}`, error);
  }
}

// Generate a hash for a chat object (for change detection)
async function generateChatHash(chat) {
  // Create a simplified chat object with only the important parts that would trigger a sync
  const simplifiedChat = {
    messages: chat.messagesArray || [],
    title: chat.chatTitle,
    updatedAt: chat.updatedAt
  };
  
  try {
    // Convert to string
    const chatString = JSON.stringify(simplifiedChat);
    
    // Generate SHA-256 hash
    const msgBuffer = new TextEncoder().encode(chatString);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    return hashHex;
  } catch (error) {
    logToConsole("error", "Error generating chat hash", error);
    // Fallback to a simple hash
    return `${chat.id}-${chat.updatedAt}-${(chat.messagesArray || []).length}`;
  }
}

// ==================== CHANGE DETECTION ====================

// Start periodic check for changes in IndexedDB
function startPeriodicChangeCheck() {
  logToConsole("info", "Starting periodic change detection");
  // Clear any existing interval
  if (window.changeCheckInterval) {
    clearInterval(window.changeCheckInterval);
  }
  
  // Set interval for checking changes (every 5 seconds)
  window.changeCheckInterval = setInterval(checkForChanges, 2500);
  
  // This log is redundant with the one above
}

// Check for changes in chats by comparing hash first, then timestamps
async function checkForChanges() {
  if (document.hidden) return; // Skip if tab is not visible
  
  try {
    const chats = await getAllChatsFromIndexedDB();
    const changedChats = [];
    
    for (const chat of chats) {
      if (!chat.id) continue;
      
      // Get current chat hash
      const currentHash = await generateChatHash(chat);
      
      // Check if this chat has been updated since we last saw it
      if (!lastSeenUpdates[chat.id] ||
          currentHash !== lastSeenUpdates[chat.id].hash ||
          (currentHash === lastSeenUpdates[chat.id].hash && chat.updatedAt > lastSeenUpdates[chat.id].timestamp)) {
        
        changedChats.push(chat.id);
        
        // Update last seen data
        lastSeenUpdates[chat.id] = {
          hash: currentHash,
          timestamp: chat.updatedAt || 0
        };
        
        // Update metadata
        await updateChatMetadata(chat.id, true);
        
        // Queue for sync
        queueOperation(`chat-changed-${chat.id}`, () => uploadChatToCloud(chat.id));
      }
    }
    
    if (changedChats.length > 0) {
      logToConsole("info", "Detected changes in chats", {
        changedChats: changedChats,
        count: changedChats.length
      });
    }
    // No need to log when nothing changes - reduces noise
  } catch (error) {
    logToConsole("error", "Error checking for changes", error);
  }
}

// Setup localStorage change listener for settings
function setupLocalStorageChangeListener() {
  // Override localStorage.setItem to detect changes
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = function(key, value) {
    // Check if this is a settings change
    const excludeKeys = [
      "chat-sync-metadata", "last-cloud-sync", "activeTabBackupRunning", "TM_useDraftContent"
    ];
    const oldValue = localStorage.getItem(key);
    
    // Call original implementation
    originalSetItem.call(this, key, value);
    
    // If value changed and it's not an excluded key
    if (oldValue !== value && !excludeKeys.includes(key)) {
      logToConsole("info", `LocalStorage change detected: ${key}`);
      updateSettingsMetadata();
      queueOperation('settings-modified', uploadSettingsToCloud);
    }
  };
  
  // No need to log this setup process
}

// Update settings metadata
function updateSettingsMetadata() {
  localMetadata.settings.lastModified = Date.now();
  saveLocalMetadata();
}

// ==================== AWS S3 OPERATIONS ====================

// Get AWS S3 client with proper credentials
function getS3Client() {
  const bucketName = localStorage.getItem("aws-bucket");
  const awsRegion = localStorage.getItem("aws-region");
  const awsAccessKey = localStorage.getItem("aws-access-key");
  const awsSecretKey = localStorage.getItem("aws-secret-key");
  const awsEndpoint = localStorage.getItem("aws-endpoint");
  
  if (!bucketName || !awsAccessKey || !awsSecretKey) {
    throw new Error("AWS credentials not configured");
  }
  
  // Create credential object directly to avoid S3 credential provider chain issues
  const credentials = new AWS.Credentials({
    accessKeyId: awsAccessKey,
    secretAccessKey: awsSecretKey
  });
  
  const awsConfig = {
    credentials: credentials,
    region: awsRegion,
    maxRetries: 3,
    httpOptions: { timeout: 30000 } // 30 second timeout
  };
  
  if (awsEndpoint) {
    awsConfig.endpoint = awsEndpoint;
  }
  
  AWS.config.update(awsConfig);
  return { s3: new AWS.S3(awsConfig), bucketName };
}

// Download metadata from cloud
async function downloadCloudMetadata() {
  // Metadata operations happen frequently and don't need to be logged
  
  try {
    const { s3, bucketName } = getS3Client();
    
    // Check if metadata.json exists
    try {
      const params = {
        Bucket: bucketName,
        Key: "metadata.json"
      };
      
      const data = await s3.getObject(params).promise();
      const encryptedContent = new Uint8Array(data.Body);
      const metadataJson = await decryptData(encryptedContent);
      
      logToConsole("success", "Downloaded cloud metadata", {
        chatCount: Object.keys(metadataJson.chats || {}).length,
        lastSyncTime: metadataJson.lastSyncTime ? new Date(metadataJson.lastSyncTime).toLocaleString() : 'None'
      });
      
      return metadataJson;
    } catch (error) {
      if (error.code === "NoSuchKey") {
        logToConsole("info", "No metadata.json found in cloud, creating new one");
        // Upload current metadata to create it
        await uploadCloudMetadata(localMetadata);
        return localMetadata;
      }
      throw error;
    }
  } catch (error) {
    logToConsole("error", "Error downloading cloud metadata", error);
    throw error;
  }
}

// Upload metadata to cloud
async function uploadCloudMetadata(metadata) {
  // Metadata operations happen frequently and don't need to be logged
  
  try {
    const { s3, bucketName } = getS3Client();
    
    // Set last sync time
    metadata.lastSyncTime = Date.now();
    
    // Encrypt metadata
    const encryptedData = await encryptData(metadata);
    
    // Upload to S3
    const params = {
      Bucket: bucketName,
      Key: "metadata.json",
      Body: encryptedData,
      ContentType: "application/json",
      ServerSideEncryption: "AES256"
    };
    
    await s3.putObject(params).promise();
    
    logToConsole("success", "Uploaded cloud metadata");
    
    // Update local metadata's last sync time
    localMetadata.lastSyncTime = metadata.lastSyncTime;
    saveLocalMetadata();
    
    return true;
  } catch (error) {
    logToConsole("error", "Error uploading cloud metadata", error);
    throw error;
  }
}

// Download a chat from cloud
async function downloadChatFromCloud(chatId) {
  logToConsole("download", `Downloading chat ${chatId} from cloud`);
  
  try {
    const { s3, bucketName } = getS3Client();
    
    // Download chat file
    const params = {
      Bucket: bucketName,
      Key: `chats/${chatId}.json`
    };
    
    try {
      const data = await s3.getObject(params).promise();
      const encryptedContent = new Uint8Array(data.Body);
      const chatData = await decryptData(encryptedContent);
      
      logToConsole("success", `Downloaded chat ${chatId} from cloud`, {
        messageCount: (chatData.messagesArray || []).length,
        title: chatData.chatTitle
      });
      
      return chatData;
    } catch (error) {
      if (error.code === "NoSuchKey") {
        logToConsole("info", `Chat ${chatId} not found in cloud`);
        return null;
      }
      throw error;
    }
  } catch (error) {
    logToConsole("error", `Error downloading chat ${chatId}`, error);
    throw error;
  }
}

// Upload a chat to cloud
async function uploadChatToCloud(chatId) {
  logToConsole("upload", `Uploading chat ${chatId} to cloud`);
  
  try {
    const { s3, bucketName } = getS3Client();
    
    // Get chat data
    const chatData = await getChatFromIndexedDB(chatId);
    if (!chatData) {
      logToConsole("warning", `Chat ${chatId} not found in IndexedDB, skipping upload`);
      return false;
    }
    
    // Encrypt chat data
    const encryptedData = await encryptData(chatData);
    
    // Upload to S3
    const params = {
      Bucket: bucketName,
      Key: `chats/${chatId}.json`,
      Body: encryptedData,
      ContentType: "application/json",
      ServerSideEncryption: "AES256"
    };
    
    await s3.putObject(params).promise();
    
    logToConsole("success", `Uploaded chat ${chatId} to cloud`, {
      messageCount: (chatData.messagesArray || []).length,
      title: chatData.chatTitle
    });
    
    // Update metadata
    await updateChatMetadata(chatId, false);
    
    // Update cloud metadata
    const cloudMetadata = await downloadCloudMetadata();
    if (!cloudMetadata.chats) cloudMetadata.chats = {};
    
    cloudMetadata.chats[chatId] = {
      lastModified: chatData.updatedAt || Date.now(),
      syncedAt: Date.now(),
      hash: localMetadata.chats[chatId]?.hash || await generateChatHash(chatData)
    };
    
    await uploadCloudMetadata(cloudMetadata);
    
    return true;
  } catch (error) {
    logToConsole("error", `Error uploading chat ${chatId}`, error);
    throw error;
  }
}

// Delete a chat from cloud
async function deleteChatFromCloud(chatId) {
  logToConsole("cleanup", `Deleting chat ${chatId} from cloud`);
  
  try {
    const { s3, bucketName } = getS3Client();
    
    // Delete chat file from S3
    const params = {
      Bucket: bucketName,
      Key: `chats/${chatId}.json`
    };
    
    await s3.deleteObject(params).promise();
    
    logToConsole("success", `Deleted chat ${chatId} from cloud`);
    
    // Update cloud metadata to remove the chat
    const cloudMetadata = await downloadCloudMetadata();
    if (cloudMetadata.chats && cloudMetadata.chats[chatId]) {
      delete cloudMetadata.chats[chatId];
      await uploadCloudMetadata(cloudMetadata);
    }
    
    // Create a "tombstone" entry in local metadata to mark this chat as deleted
    // This prevents the chat from being re-downloaded in future syncs
    if (localMetadata.chats) {
      localMetadata.chats[chatId] = {
        deleted: true,
        deletedAt: Date.now(),
        lastModified: Date.now(),
        syncedAt: Date.now() // Mark as synced to prevent re-uploading
      };
      saveLocalMetadata();
      logToConsole("info", `Created tombstone entry for deleted chat ${chatId} in local metadata`);
    }
    
    return true;
  } catch (error) {
    logToConsole("error", `Error deleting chat ${chatId} from cloud`, error);
    throw error;
  }
}

// Delete a chat locally from IndexedDB
async function deleteLocalChat(chatId) {
  logToConsole("cleanup", `Deleting chat ${chatId} locally`);
  
  try {
    const key = chatId.startsWith('CHAT_') ? chatId : `CHAT_${chatId}`;
    const request = indexedDB.open("keyval-store", 1);
    
    const db = await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => resolve(event.target.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('keyval')) {
          db.createObjectStore('keyval');
        }
      };
    });
    
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(["keyval"], "readwrite");
      const store = transaction.objectStore("keyval");
      const deleteRequest = store.delete(key);
      
      deleteRequest.onsuccess = () => {
        logToConsole("success", `Deleted chat ${chatId} from local IndexedDB`);
        resolve();
      };
      
      deleteRequest.onerror = () => {
        reject(deleteRequest.error);
      };
    });
    
    // Create a "tombstone" entry in metadata to mark this chat as deleted
    // This prevents the chat from being re-downloaded if it exists in the cloud
    if (localMetadata.chats) {
      localMetadata.chats[chatId] = {
        deleted: true,
        deletedAt: Date.now(),
        lastModified: Date.now(),
        syncedAt: 0
      };
      saveLocalMetadata();
      logToConsole("info", `Created tombstone entry for deleted chat ${chatId} in local metadata`);
    }
    
    // Also remove from lastSeenUpdates
    if (lastSeenUpdates[chatId]) {
      delete lastSeenUpdates[chatId];
    }
    
    return true;
  } catch (error) {
    logToConsole("error", `Error deleting chat ${chatId} locally`, error);
    throw error;
  }
}

// Download settings from cloud
async function downloadSettingsFromCloud() {
  logToConsole("download", "Downloading settings.json from cloud");
  
  try {
    const { s3, bucketName } = getS3Client();
    
    // Download settings file
    const params = {
      Bucket: bucketName,
      Key: "settings.json"
    };
    
    try {
      const data = await s3.getObject(params).promise();
      const encryptedContent = new Uint8Array(data.Body);
      const settingsData = await decryptData(encryptedContent);
      
      logToConsole("success", "Downloaded settings from cloud", {
        settingsCount: Object.keys(settingsData).length
      });
      
      return settingsData;
    } catch (error) {
      if (error.code === "NoSuchKey") {
        logToConsole("info", "No settings.json found in cloud, creating it now");
        // Create it now by uploading current settings
        await uploadSettingsToCloud();
        
        // Get a copy of what was just uploaded
        const settingsData = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          // Exclude security keys
          const excludeKeys = [
            "aws-access-key", "aws-secret-key", "encryption-key", 
            "aws-endpoint", "aws-region", "aws-bucket"
          ];
          
          if (!excludeKeys.includes(key)) {
            settingsData[key] = localStorage.getItem(key);
          }
        }
        return settingsData;
      }
      throw error;
    }
  } catch (error) {
    logToConsole("error", "Error downloading settings", error);
    throw error;
  }
}

// Upload settings to cloud
async function uploadSettingsToCloud() {
  logToConsole("upload", "Uploading settings.json to cloud");
  
  try {
    const { s3, bucketName } = getS3Client();
    
    // Get ALL localStorage data
    const settingsData = {};
    
    // Extract ALL keys from localStorage (not just TM_ keys)
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      // Exclude the AWS credentials and a few technical keys for security
      const excludeKeys = [
        "aws-access-key", "aws-secret-key", "encryption-key", 
        "aws-endpoint", "aws-region", "aws-bucket"
      ];
      
      if (!excludeKeys.includes(key)) {
        settingsData[key] = localStorage.getItem(key);
      }
    }
    
    // Encrypt settings data
    const encryptedData = await encryptData(settingsData);
    
    // Upload to S3
    const params = {
      Bucket: bucketName,
      Key: "settings.json",
      Body: encryptedData,
      ContentType: "application/json",
      ServerSideEncryption: "AES256"
    };
    
    await s3.putObject(params).promise();
    
    logToConsole("success", "Uploaded settings to cloud", {
      settingsCount: Object.keys(settingsData).length
    });
    
    // Update metadata
    localMetadata.settings.syncedAt = Date.now();
    saveLocalMetadata();
    
    // Update cloud metadata
    const cloudMetadata = await downloadCloudMetadata();
    cloudMetadata.settings = {
      lastModified: Date.now(),
      syncedAt: Date.now()
    };
    
    await uploadCloudMetadata(cloudMetadata);
    
    return true;
  } catch (error) {
    logToConsole("error", "Error uploading settings", error);
    throw error;
  }
}

// ==================== SYNC OPERATIONS ====================

// Start sync interval
function startSyncInterval() {
  // Clear any existing interval
  if (window.syncInterval) {
    clearInterval(window.syncInterval);
  }
  
  // Set new interval
  const intervalMs = Math.max(syncConfig.syncInterval * 1000, 15000);
  window.syncInterval = setInterval(() => {
    if (document.hidden) return;
    
    // Queue sync operation
    queueOperation('interval-sync', syncFromCloud);
  }, intervalMs);
  
  // No need to log sync interval start - happens automatically
}

// Handle visibility change
function setupVisibilityChangeHandler() {
  document.addEventListener("visibilitychange", () => {
    // Only log when tab becomes visible (hidden state isn't as important)
    if (!document.hidden) {
      logToConsole("visibility", "Tab became visible");
    }
    
    if (!document.hidden) {
      // Tab became visible - queue sync
      queueOperation('visibility-sync', syncFromCloud);
    }
  });
  
  // No need to log setup processes
}

// Main sync function
async function syncFromCloud() {
  if (operationState.isImporting || operationState.isExporting) {
    logToConsole("skip", "Sync already in progress, queueing this sync");
    operationState.isPendingSync = true;
    return;
  }
  
  operationState.isImporting = true;
  
  try {
    logToConsole("start", "Starting sync from cloud");
    
    // Check AWS credentials
    const encryptionKey = localStorage.getItem("encryption-key");
    const bucketName = localStorage.getItem("aws-bucket");
    const awsAccessKey = localStorage.getItem("aws-access-key");
    const awsSecretKey = localStorage.getItem("aws-secret-key");
    
    if (!bucketName || !awsAccessKey || !awsSecretKey || !encryptionKey) {
      logToConsole("warning", "AWS credentials or encryption key not configured");
      throw new Error("AWS credentials or encryption key not configured");
    }
    
    // Download cloud metadata
    const cloudMetadata = await downloadCloudMetadata();
    
    // Check for settings changes
    if (cloudMetadata.settings &&
        cloudMetadata.settings.lastModified > localMetadata.settings.syncedAt) {
      logToConsole("info", "Settings changes detected in cloud");
      
      // Download settings
      const cloudSettings = await downloadSettingsFromCloud();
      
      // Apply settings if they exist
      if (cloudSettings) {
        // Apply each setting (preserving only security-related keys)
        const preserveKeys = [
          "aws-bucket", "aws-access-key", "aws-secret-key", "aws-region",
          "aws-endpoint", "encryption-key", "chat-sync-metadata"
        ];
        
        for (const [key, value] of Object.entries(cloudSettings)) {
          if (!preserveKeys.includes(key)) {
            localStorage.setItem(key, value);
          }
        }
        
        // Update local metadata
        localMetadata.settings.syncedAt = cloudMetadata.settings.lastModified;
        saveLocalMetadata();
      }
    }
    
    // Check for chat changes
    if (cloudMetadata.chats) {
      const chatChanges = {
        toDownload: [],
        toUpload: [],
        unchanged: [],
        toDelete: []
      };
      
      // Get all current chats from IndexedDB to find deleted ones
      const currentLocalChats = await getAllChatsFromIndexedDB();
      const currentLocalChatIds = new Set(currentLocalChats.map(chat => chat.id));
      
     // Identify chats that need to be downloaded or deleted
     for (const [chatId, cloudChatMeta] of Object.entries(cloudMetadata.chats)) {
       // Check if the chat exists locally (in IndexedDB)
       const chatExistsLocally = currentLocalChatIds.has(chatId);
       const localChatMeta = localMetadata.chats[chatId];
       
       // Check if this chat is marked as deleted locally (tombstone entry)
       if (localChatMeta && localChatMeta.deleted === true) {
         // This is a tombstone entry, we should delete the chat from cloud
         chatChanges.toDelete.push(chatId);
         logToConsole("cleanup", `Chat ${chatId} has a local tombstone entry - marking for deletion from cloud`);
         continue;
       }
       
       // If chat doesn't exist locally but exists in cloud and metadata, it might have been deleted
       if (!chatExistsLocally) {
         // Check if we've seen this chat before (in our metadata)
         if (localChatMeta) {
           // This chat used to exist locally but now it's gone - mark for deletion
           // We use a time threshold to differentiate between not-yet-synced and deleted chats
           const deletionThreshold = 5 * 60 * 1000; // 5 minutes in milliseconds
           const timeSinceLastSync = Date.now() - localMetadata.lastSyncTime;
           
           if (timeSinceLastSync > deletionThreshold) {
             chatChanges.toDelete.push(chatId);
             logToConsole("cleanup", `Marking chat ${chatId} for deletion - exists in cloud but not locally anymore`);
             continue;
           }
         }
       }
       
       if (!localChatMeta ||
           // First check hashes if available
           (cloudChatMeta.hash && localChatMeta.hash && cloudChatMeta.hash !== localChatMeta.hash) ||
           // Fall back to timestamp comparison only if hashes aren't available
           (!cloudChatMeta.hash || !localChatMeta.hash) && cloudChatMeta.lastModified >= localChatMeta.syncedAt) {
         // Cloud version is different or newer
         chatChanges.toDownload.push(chatId);
       } else if (localChatMeta.lastModified > localChatMeta.syncedAt) {
         // Local version is newer
         chatChanges.toUpload.push(chatId);
       } else {
         // No changes
         chatChanges.unchanged.push(chatId);
       }
     }
      
      // Identify chats that exist locally but not in cloud
      for (const chatId of Object.keys(localMetadata.chats)) {
        if (!cloudMetadata.chats[chatId]) {
          // Skip tombstone entries (already deleted chats)
          if (localMetadata.chats[chatId].deleted === true) {
            logToConsole("info", `Chat ${chatId} has a tombstone entry - skipping`);
            continue;
          }
          
          // If the chat exists locally but not in cloud metadata, we need to handle two cases:
          // 1. The chat was created locally and needs to be uploaded (if modified since last sync)
          // 2. The chat was deleted from cloud (on another device) and should be deleted locally
          
          if (localMetadata.chats[chatId].lastModified > localMetadata.chats[chatId].syncedAt) {
            // Case 1: Local chat has changes, upload it
            chatChanges.toUpload.push(chatId);
          } else if (localMetadata.lastSyncTime > 0) {
            // Case 2: Chat was deleted from cloud (on another device)
            // Only process this if we've synced at least once before
            chatChanges.toDelete.push(chatId);
            logToConsole("cleanup", `Marking local chat ${chatId} for deletion - exists locally but not in cloud metadata`);
          }
        }
      }
      
      // Only log sync status if there are changes to make
      if (chatChanges.toDownload.length > 0 || chatChanges.toUpload.length > 0 || chatChanges.toDelete.length > 0) {
        logToConsole("info", "Chat sync status", {
          toDownload: chatChanges.toDownload.length,
          toUpload: chatChanges.toUpload.length,
          toDelete: chatChanges.toDelete.length
        });
      }
      
      // Process downloads
      if (chatChanges.toDownload.length > 0) {
        for (const chatId of chatChanges.toDownload) {
          try {
            // Skip downloading if this chat has a tombstone entry (meaning it was deleted locally)
            if (localMetadata.chats[chatId] && localMetadata.chats[chatId].deleted === true) {
              logToConsole("info", `Skipping download of chat ${chatId} - marked as deleted locally`);
              // Instead, mark it for deletion from cloud
              if (!chatChanges.toDelete.includes(chatId)) {
                chatChanges.toDelete.push(chatId);
              }
              continue;
            }
            
            const cloudChat = await downloadChatFromCloud(chatId);
            
            if (cloudChat) {
              // Check for local version to handle potential conflicts
              const localChat = await getChatFromIndexedDB(chatId);
              
              if (localChat) {
                // Both versions exist - check for conflicts
                if (localMetadata.chats[chatId] &&
                    localMetadata.chats[chatId].lastModified > localMetadata.chats[chatId].syncedAt) {
                  // Conflict - need to merge
                  const mergedChat = await mergeChats(localChat, cloudChat);
                  await saveChatToIndexedDB(mergedChat);
                  logToConsole("info", `Merged chat ${chatId} (conflict resolution)`);
                } else {
                  // No conflict - just replace
                  await saveChatToIndexedDB(cloudChat);
                  logToConsole("info", `Updated chat ${chatId} from cloud`);
                }
              } else {
                // Local version doesn't exist - just save
                await saveChatToIndexedDB(cloudChat);
                logToConsole("info", `Created chat ${chatId} from cloud`);
              }
              
              // Update metadata and last seen updates
              await updateChatMetadata(chatId, false);
              // Update hash and timestamp in lastSeenUpdates
              const cloudChatHash = await generateChatHash(cloudChat);
              lastSeenUpdates[chatId] = {
                hash: cloudChatHash,
                timestamp: cloudChat.updatedAt || 0
              };
            }
          } catch (error) {
            logToConsole("error", `Error processing download for chat ${chatId}`, error);
          }
        }
      }
      
      // Process uploads (with a small delay to avoid credential conflicts)
      if (chatChanges.toUpload.length > 0) {
        for (const chatId of chatChanges.toUpload) {
          try {
            await uploadChatToCloud(chatId);
            // Small delay between uploads
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (error) {
            logToConsole("error", `Error uploading chat ${chatId}`, error);
          }
        }
      }
      
      // Process deletions (both locally deleted chats and chats deleted in cloud)
      if (chatChanges.toDelete.length > 0) {
        logToConsole("cleanup", `Processing ${chatChanges.toDelete.length} deleted chats`);
        for (const chatId of chatChanges.toDelete) {
          try {
            // Check if this is a local or cloud deletion, or a tombstone entry
            const chatExistsLocally = currentLocalChatIds.has(chatId);
            const hasTombstone = localMetadata.chats[chatId] && localMetadata.chats[chatId].deleted === true;
            
            if (hasTombstone) {
              // This is a tombstone entry, we should delete it from cloud if it exists there
              await deleteChatFromCloud(chatId);
              logToConsole("success", `Deleted chat ${chatId} from cloud based on local tombstone entry`);
              // Keep the tombstone entry in metadata to prevent future re-downloads
            } else if (!chatExistsLocally) {
              // Chat was deleted locally but no tombstone yet, remove it from the cloud
              // and create a tombstone entry
              await deleteChatFromCloud(chatId);
              logToConsole("success", `Deleted chat ${chatId} from cloud (local deletion)`);
              
              // Create a tombstone if one doesn't exist
              if (!hasTombstone) {
                localMetadata.chats[chatId] = {
                  deleted: true,
                  deletedAt: Date.now(),
                  lastModified: Date.now(),
                  syncedAt: Date.now()
                };
                saveLocalMetadata();
                logToConsole("info", `Created tombstone entry for chat ${chatId} that was deleted locally`);
              }
            } else {
              // Chat exists locally but was deleted in cloud, delete it locally too
              logToConsole("info", `Deleting local chat ${chatId} that was removed from cloud`);
              await deleteLocalChat(chatId);
              
              // The deleteLocalChat function already creates a tombstone entry,
              // so we don't need to manually edit the metadata here
            }
            
            // Small delay between deletions
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (error) {
            logToConsole("error", `Error processing deletion for chat ${chatId}`, error);
          }
        }
      }
    }
    
    // Update sync status
    localStorage.setItem("last-cloud-sync", new Date().toLocaleString());
    
    logToConsole("success", "Sync completed successfully");
    operationState.lastSyncStatus = "success";
  } catch (error) {
    // Always log sync failures prominently
    console.error("❌ SYNC ERROR:", error);
    logToConsole("error", "Sync failed - check connection and S3 credentials");
    operationState.lastSyncStatus = "failed";
    throw error;
  } finally {
    operationState.isImporting = false;
    
    // Check if another sync was requested while this one was running
    if (operationState.isPendingSync) {
      operationState.isPendingSync = false;
      queueOperation('pending-sync', syncFromCloud);
    }
  }
}

// Merge two versions of a chat (conflict resolution)
async function mergeChats(localChat, cloudChat) {
  logToConsole("info", "Merging chat versions", {
    chatId: localChat.id,
    localMessages: (localChat.messagesArray || []).length,
    cloudMessages: (cloudChat.messagesArray || []).length
  });
  
  // Create a fresh copy to work with
  const mergedChat = JSON.parse(JSON.stringify(localChat));
  
  // Use the most recent metadata
  mergedChat.updatedAt = Math.max(
    localChat.updatedAt || 0,
    cloudChat.updatedAt || 0
  );
  
  // Use the most recent title
  if (cloudChat.chatTitle && (!localChat.chatTitle || cloudChat.updatedAt > localChat.updatedAt)) {
    mergedChat.chatTitle = cloudChat.chatTitle;
  }
  
  // Handle message merging
  if (!mergedChat.messagesArray) mergedChat.messagesArray = [];
  if (!cloudChat.messagesArray) cloudChat.messagesArray = [];
  
  // Create a map of message IDs we already have
  const messageMap = new Map();
  for (const msg of mergedChat.messagesArray) {
    const msgId = msg.id || JSON.stringify(msg);
    messageMap.set(msgId, true);
  }
  
  // Add messages from cloud that don't exist locally
  for (const cloudMsg of cloudChat.messagesArray) {
    const msgId = cloudMsg.id || JSON.stringify(cloudMsg);
    if (!messageMap.has(msgId)) {
      mergedChat.messagesArray.push(cloudMsg);
      messageMap.set(msgId, true);
    }
  }
  
  // Sort messages by timestamp or index
  mergedChat.messagesArray.sort((a, b) => {
    // First by timestamp if available
    if (a.timestamp && b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    // Then by message index if available
    if (a.index !== undefined && b.index !== undefined) {
      return a.index - b.index;
    }
    // Default to keeping existing order
    return 0;
  });
  
  logToConsole("success", "Chat merge completed", {
    messageCount: mergedChat.messagesArray.length
  });
  
  return mergedChat;
}

// ==================== INDEXEDDB OPERATIONS ====================

// Get all chats from IndexedDB
async function getAllChatsFromIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("keyval-store", 1);
    
    request.onerror = () => reject(request.error);
    
    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction(["keyval"], "readonly");
      const store = transaction.objectStore("keyval");
      const chats = [];
      
      // Get all chat keys
      store.getAllKeys().onsuccess = (keyEvent) => {
        const keys = keyEvent.target.result;
        const chatKeys = keys.filter(key => key.startsWith('CHAT_'));
        
        if (chatKeys.length === 0) {
          resolve([]);
          return;
        }
        
        // Get all chat data
        store.getAll().onsuccess = (valueEvent) => {
          const values = valueEvent.target.result;
          for (let i = 0; i < keys.length; i++) {
            if (keys[i].startsWith('CHAT_')) {
              chats.push(values[i]);
            }
          }
          resolve(chats);
        };
      };
    };
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('keyval')) {
        db.createObjectStore('keyval');
      }
    };
  });
}

// Get a specific chat from IndexedDB
async function getChatFromIndexedDB(chatId) {
  return new Promise((resolve, reject) => {
    const key = chatId.startsWith('CHAT_') ? chatId : `CHAT_${chatId}`;
    const request = indexedDB.open("keyval-store", 1);
    
    request.onerror = () => reject(request.error);
    
    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction(["keyval"], "readonly");
      const store = transaction.objectStore("keyval");
      
      const getRequest = store.get(key);
      
      getRequest.onsuccess = () => {
        resolve(getRequest.result);
      };
      
      getRequest.onerror = () => {
        reject(getRequest.error);
      };
    };
  });
}

// Save a chat to IndexedDB
async function saveChatToIndexedDB(chat) {
  return new Promise((resolve, reject) => {
    const key = `CHAT_${chat.id}`;
    const request = indexedDB.open("keyval-store", 1);
    
    request.onerror = () => reject(request.error);
    
    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction(["keyval"], "readwrite");
      const store = transaction.objectStore("keyval");
      
      const putRequest = store.put(chat, key);
      
      putRequest.onsuccess = () => {
        resolve();
      };
      
      putRequest.onerror = () => {
        reject(putRequest.error);
      };
    };
  });
}

// ==================== OPERATION QUEUE ====================

// Queue an operation for execution
function queueOperation(name, operation) {
  // Check for duplicates
  if (operationState.operationQueue.some(op => op.name === name)) {
    logToConsole("skip", `Skipping duplicate operation: ${name}`);
    return;
  }
  
  operationState.operationQueue.push({ name, operation });
  // Only log important operations
  if (name.startsWith('initial') || name.startsWith('manual') || name.startsWith('visibility')) {
    logToConsole("info", `Added '${name}' to operation queue`);
  }
  
  // Start processing if not already processing
  if (!operationState.isProcessingQueue) {
    processOperationQueue();
  }
}

// Process operation queue
async function processOperationQueue() {
  if (operationState.isProcessingQueue || operationState.operationQueue.length === 0) {
    return;
  }
  
  operationState.isProcessingQueue = true;
  // Only log queue processing for 2+ items to reduce noise
  if (operationState.operationQueue.length > 1) {
    logToConsole("info", `Processing operation queue (${operationState.operationQueue.length} items)`);
  }
  
  while (operationState.operationQueue.length > 0) {
    const nextOperation = operationState.operationQueue[0];
    try {
      // Only log important operations
      if (nextOperation.name.startsWith('initial') || nextOperation.name.startsWith('manual') || nextOperation.name.startsWith('visibility')) {
        logToConsole("info", `Executing operation: ${nextOperation.name}`);
      }
      await nextOperation.operation();
      
      // Add a small delay to ensure proper completion
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // No need to log each operation completion
      operationState.operationQueue.shift();
    } catch (error) {
      logToConsole("error", `Error executing operation ${nextOperation.name}:`, error);
      operationState.operationQueue.shift();
      
      // Add a delay after errors to prevent rapid retries
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  operationState.isProcessingQueue = false;
  // No need to log queue processing completion
}

// ==================== ENCRYPTION/DECRYPTION ====================

// Derive encryption key
async function deriveKey(password) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );
  
  const salt = enc.encode("typingmind-backup-salt");
  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Encrypt data
async function encryptData(data) {
  const encryptionKey = localStorage.getItem("encryption-key");
  
  if (!encryptionKey) {
    logToConsole("warning", "No encryption key found");
    throw new Error("Encryption key not configured");
  }
  
  try {
    const key = await deriveKey(encryptionKey);
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encodedData = enc.encode(JSON.stringify(data));
    
    const encryptedContent = await window.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      encodedData
    );
    
    const marker = new TextEncoder().encode("ENCRYPTED:");
    const combinedData = new Uint8Array(
      marker.length + iv.length + encryptedContent.byteLength
    );
    
    combinedData.set(marker);
    combinedData.set(iv, marker.length);
    combinedData.set(
      new Uint8Array(encryptedContent),
      marker.length + iv.length
    );
    
    return combinedData;
  } catch (error) {
    logToConsole("error", "Encryption failed:", error);
    throw error;
  }
}

// Decrypt data
async function decryptData(data) {
  const marker = "ENCRYPTED:";
  
  // Check if the data is a proper Uint8Array with enough length
  if (!data || data.length < marker.length) {
    logToConsole("error", "Invalid data format for decryption");
    return {};
  }
  
  const dataString = new TextDecoder().decode(data.slice(0, marker.length));
  
  if (dataString !== marker) {
    logToConsole("info", "Data is not encrypted, returning as-is");
    try {
      // Try to parse as JSON
      const textData = new TextDecoder().decode(data);
      return JSON.parse(textData);
    } catch (parseError) {
      logToConsole("error", "JSON parse error on non-encrypted data:", parseError);
      logToConsole("info", "Raw data (first 100 chars):", new TextDecoder().decode(data).substring(0, 100));
      // Return empty object as fallback
      return {};
    }
  }
  
  const encryptionKey = localStorage.getItem("encryption-key");
  if (!encryptionKey) {
    logToConsole("error", "Encrypted data found but no key provided");
    throw new Error("Encryption key not configured");
  }
  
  try {
    const key = await deriveKey(encryptionKey);
    const iv = data.slice(marker.length, marker.length + 12);
    const content = data.slice(marker.length + 12);
    
    const decryptedContent = await window.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      content
    );
    
    const dec = new TextDecoder();
    const decryptedString = dec.decode(decryptedContent);
    return JSON.parse(decryptedString);
  } catch (error) {
    logToConsole("error", "Decryption failed:", error);
    throw error;
  }
}

// ==================== UI COMPONENTS ====================

// Insert sync button
function insertSyncButton() {
  // Create button element if it doesn't exist
  if (document.querySelector('[data-element-id="cloud-sync-button"]')) return;
  
  const cloudSyncBtn = document.createElement("button");
  cloudSyncBtn.setAttribute("data-element-id", "cloud-sync-button");
  cloudSyncBtn.className =
    "cursor-default group flex items-center justify-center p-1 text-sm font-medium flex-col group focus:outline-0 focus:text-white text-white/70";
  
  const cloudIconSVG = `
    <svg class="w-6 h-6 flex-shrink-0" width="24px" height="24px" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M19 9.76c-.12-3.13-2.68-5.64-5.83-5.64-2.59 0-4.77 1.68-5.53 4.01-.19-.03-.39-.04-.57-.04-2.45 0-4.44 1.99-4.44 4.44 0 2.45 1.99 4.44 4.44 4.44h11.93c2.03 0 3.67-1.64 3.67-3.67 0-1.95-1.52-3.55-3.44-3.65zm-5.83-3.64c2.15 0 3.93 1.6 4.21 3.68l.12.88.88.08c1.12.11 1.99 1.05 1.99 2.19 0 1.21-.99 2.2-2.2 2.2H7.07c-1.64 0-2.97-1.33-2.97-2.97 0-1.64 1.33-2.97 2.97-2.97.36 0 .72.07 1.05.2l.8.32.33-.8c.59-1.39 1.95-2.28 3.45-2.28z" fill="currentColor"></path>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M12 15.33v-5.33M9.67 12.33L12 14.67l2.33-2.34" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
  
  const textSpan = document.createElement("span");
  textSpan.className = "font-normal self-stretch text-center text-xs leading-4 md:leading-none";
  textSpan.innerText = "Sync";
  
  const iconSpan = document.createElement("span");
  iconSpan.className = "block group-hover:bg-white/30 w-[35px] h-[35px] transition-all rounded-lg flex items-center justify-center group-hover:text-white/90";
  iconSpan.innerHTML = cloudIconSVG;
  
  cloudSyncBtn.appendChild(iconSpan);
  cloudSyncBtn.appendChild(textSpan);
  
  // Insert button into DOM (look for 'teams' button and insert after it)
  function insertButton() {
    const teamsButton = document.querySelector('[data-element-id="workspace-tab-teams"]');
    if (teamsButton && teamsButton.parentNode) {
      teamsButton.parentNode.insertBefore(cloudSyncBtn, teamsButton.nextSibling);
      return true;
    }
    return false;
  }
  
  // Try to insert button immediately
  if (insertButton()) {
    logToConsole("info", "Sync button inserted into DOM");
  } else {
    // If not possible yet, observe DOM changes
    const observer = new MutationObserver((mutations) => {
      if (insertButton()) {
        observer.disconnect();
        logToConsole("info", "Sync button inserted into DOM (via observer)");
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    
    // Also try periodically
    let attempts = 0;
    const maxAttempts = 10;
    const interval = setInterval(() => {
      if (insertButton() || attempts >= maxAttempts) {
        clearInterval(interval);
      }
      attempts++;
    }, 1000);
  }
  
  // Add click handler to open settings modal
  cloudSyncBtn.addEventListener("click", openSyncModal);
}

// Create and open sync settings modal (basic implementation)
function openSyncModal() {
  // Don't create multiple instances
  if (document.querySelector('[data-element-id="sync-modal"]')) return;
  
  // Create modal element
  const modalElement = document.createElement("div");
  modalElement.setAttribute("data-element-id", "sync-modal");
  modalElement.className = "fixed inset-0 bg-gray-800 bg-opacity-75 flex items-center justify-center z-[60] p-4 overflow-y-auto";
  
  modalElement.innerHTML = `
    <div class="inline-block w-full align-bottom bg-white dark:bg-zinc-950 rounded-lg text-left shadow-xl transform transition-all sm:my-8 sm:p-6 sm:align-middle pt-4 overflow-hidden sm:max-w-lg">
      <div class="text-gray-800 dark:text-white text-left text-sm">
        <div class="flex justify-center items-center mb-3">
          <h3 class="text-center text-xl font-bold">Cloud Sync Settings</h3>
          <button class="ml-2 text-blue-600 text-lg" aria-label="Information">ⓘ</button>
        </div>
        
        <div class="space-y-3">
          <!-- Sync Mode -->
          <div class="flex items-center space-x-4 mb-4 bg-gray-100 dark:bg-zinc-800 p-3 rounded-lg">
            <label class="text-sm font-medium text-gray-700 dark:text-gray-400">Mode:</label>
            <label class="inline-flex items-center">
              <input type="radio" name="sync-mode" value="sync" class="form-radio text-blue-600">
              <span class="ml-2">Sync</span>
            </label>
            <label class="inline-flex items-center">
              <input type="radio" name="sync-mode" value="backup" class="form-radio text-blue-600">
              <span class="ml-2">Backup</span>
            </label>
          </div>
          
          <!-- AWS Credentials -->
          <div class="bg-gray-100 dark:bg-zinc-800 p-3 rounded-lg space-y-3">
            <div class="flex space-x-4">
              <div class="w-2/3">
                <label for="aws-bucket" class="block text-sm font-medium text-gray-700 dark:text-gray-400">Bucket Name <span class="text-red-500">*</span></label>
                <input id="aws-bucket" name="aws-bucket" type="text" class="w-full px-2 py-1.5 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-zinc-700" autocomplete="off" required>
              </div>
              <div class="w-1/3">
                <label for="aws-region" class="block text-sm font-medium text-gray-700 dark:text-gray-400">Region <span class="text-red-500">*</span></label>
                <input id="aws-region" name="aws-region" type="text" class="w-full px-2 py-1.5 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-zinc-700" autocomplete="off" required>
              </div>
            </div>
            <div>
              <label for="aws-access-key" class="block text-sm font-medium text-gray-700 dark:text-gray-400">Access Key <span class="text-red-500">*</span></label>
              <input id="aws-access-key" name="aws-access-key" type="password" class="w-full px-2 py-1.5 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-zinc-700" autocomplete="off" required>
            </div>
            <div>
              <label for="aws-secret-key" class="block text-sm font-medium text-gray-700 dark:text-gray-400">Secret Key <span class="text-red-500">*</span></label>
              <input id="aws-secret-key" name="aws-secret-key" type="password" class="w-full px-2 py-1.5 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-zinc-700" autocomplete="off" required>
            </div>
            <div>
              <label for="aws-endpoint" class="block text-sm font-medium text-gray-700 dark:text-gray-400">
                S3 Compatible Storage Endpoint
              </label>
              <input id="aws-endpoint" name="aws-endpoint" type="text" class="w-full px-2 py-1.5 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-zinc-700" autocomplete="off">
            </div>
            <div class="flex space-x-4">
              <div class="w-1/2">
                <label for="backup-interval" class="block text-sm font-medium text-gray-700 dark:text-gray-400">Sync Interval (sec)</label>
                <input id="backup-interval" name="backup-interval" type="number" min="15" placeholder="Default: 60" class="w-full px-2 py-1.5 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-zinc-700" autocomplete="off" required>
              </div>
              <div class="w-1/2">
                <label for="encryption-key" class="block text-sm font-medium text-gray-700 dark:text-gray-400">
                  Encryption Key <span class="text-red-500">*</span>
                </label>
                <input id="encryption-key" name="encryption-key" type="password" class="w-full px-2 py-1.5 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-zinc-700" autocomplete="off" required>
              </div>
            </div>
          </div>
          
          <!-- Console logging -->
          <div class="flex items-center justify-end mb-4 space-x-2">
            <span class="text-sm text-gray-600 dark:text-gray-400">
              Console Logging
            </span>
            <input type="checkbox" id="console-logging-toggle" class="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded cursor-pointer">
          </div>
          
          <!-- Action buttons -->
          <div class="flex justify-between space-x-2 mt-4">
            <div>
              <button id="save-settings-btn" type="button" class="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-default">
                Save Settings
              </button>
            </div>
            <div class="flex space-x-2">
              <button id="sync-now-btn" type="button" class="inline-flex items-center px-2 py-1 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:bg-gray-400 disabled:cursor-default">
                <span>Sync Now</span>
              </button>
              <button id="close-modal-btn" type="button" class="inline-flex items-center px-2 py-1 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500">
                <span>Close</span>
              </button>
            </div>
          </div>
          
          <!-- Status message -->
          <div class="text-center mt-4">
            <span id="last-sync-msg"></span>
          </div>
          <div id="action-msg" class="text-center"></div>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modalElement);
  
  // Load existing values
  loadExistingModalValues();
  
  // Add event listeners
  document.getElementById("save-settings-btn").addEventListener("click", saveSettingsFromModal);
  document.getElementById("sync-now-btn").addEventListener("click", syncNowFromModal);
  document.getElementById("close-modal-btn").addEventListener("click", closeModal);
  document.getElementById("console-logging-toggle").addEventListener("change", toggleConsoleLogging);
  
  // Close on outside click
  modalElement.addEventListener("click", (e) => {
    if (e.target === modalElement) {
      closeModal();
    }
  });
}

// Load existing values into modal
function loadExistingModalValues() {
  // AWS credentials
  document.getElementById("aws-bucket").value = localStorage.getItem("aws-bucket") || "";
  document.getElementById("aws-region").value = localStorage.getItem("aws-region") || "";
  document.getElementById("aws-access-key").value = localStorage.getItem("aws-access-key") || "";
  document.getElementById("aws-secret-key").value = localStorage.getItem("aws-secret-key") || "";
  document.getElementById("aws-endpoint").value = localStorage.getItem("aws-endpoint") || "";
  
  // Sync settings
  document.getElementById("backup-interval").value = localStorage.getItem("backup-interval") || "60";
  document.getElementById("encryption-key").value = localStorage.getItem("encryption-key") || "";
  
  // Sync mode
  const syncMode = localStorage.getItem("sync-mode") || "sync";
  document.querySelector(`input[name="sync-mode"][value="${syncMode}"]`).checked = true;
  
  // Console logging
  document.getElementById("console-logging-toggle").checked = isConsoleLoggingEnabled;
  
  // Last sync message
  const lastSync = localStorage.getItem("last-cloud-sync");
  if (lastSync) {
    document.getElementById("last-sync-msg").textContent = `Last sync done at ${lastSync}`;
  }
}

// Save settings from modal
function saveSettingsFromModal() {
  const bucketName = document.getElementById("aws-bucket").value.trim();
  const region = document.getElementById("aws-region").value.trim();
  const accessKey = document.getElementById("aws-access-key").value.trim();
  const secretKey = document.getElementById("aws-secret-key").value.trim();
  const endpoint = document.getElementById("aws-endpoint").value.trim();
  const backupInterval = document.getElementById("backup-interval").value;
  const encryptionKey = document.getElementById("encryption-key").value.trim();
  const selectedMode = document.querySelector('input[name="sync-mode"]:checked').value;
  
  // Validate settings
  if (!bucketName || !region || !accessKey || !secretKey || !encryptionKey) {
    showModalMessage("Please fill in all required fields", "error");
    return;
  }
  
  if (parseInt(backupInterval) < 15) {
    showModalMessage("Sync interval must be at least 15 seconds", "error");
    return;
  }
  
  if (encryptionKey.length < 8) {
    showModalMessage("Encryption key must be at least 8 characters long", "error");
    return;
  }
  
  // Save settings to localStorage
  localStorage.setItem("aws-bucket", bucketName);
  localStorage.setItem("aws-region", region);
  localStorage.setItem("aws-access-key", accessKey);
  localStorage.setItem("aws-secret-key", secretKey);
  localStorage.setItem("aws-endpoint", endpoint);
  localStorage.setItem("backup-interval", backupInterval);
  localStorage.setItem("encryption-key", encryptionKey);
  localStorage.setItem("sync-mode", selectedMode);
  
  // Update sync config
  syncConfig.syncMode = selectedMode;
  syncConfig.syncInterval = parseInt(backupInterval);
  
  // Restart sync interval
  startSyncInterval();
  
  // Show success message
  showModalMessage("Settings saved successfully", "success");
  
  // If in sync mode, trigger a sync
  if (selectedMode === "sync") {
    queueOperation("settings-save-sync", syncFromCloud);
  }
}

// Sync now from modal
function syncNowFromModal() {
  queueOperation("manual-sync", syncFromCloud);
  showModalMessage("Sync started", "info");
}

// Close modal
function closeModal() {
  document.querySelector('[data-element-id="sync-modal"]')?.remove();
}

// Toggle console logging
function toggleConsoleLogging(e) {
  isConsoleLoggingEnabled = e.target.checked;
  
  if (isConsoleLoggingEnabled) {
    logToConsole("info", `Chat Sync Extension v${EXTENSION_VERSION}`);
    const url = new URL(window.location);
    url.searchParams.set("log", "true");
    window.history.replaceState({}, "", url);
  } else {
    const url = new URL(window.location);
    url.searchParams.delete("log");
    window.history.replaceState({}, "", url);
  }
}

// Show message in modal
function showModalMessage(message, type = "info") {
  const msgElement = document.getElementById("action-msg");
  if (!msgElement) return;
  
  msgElement.textContent = message;
  
  // Set color based on type
  switch (type) {
    case "error":
      msgElement.style.color = "#EF4444";
      break;
    case "success":
      msgElement.style.color = "#10B981";
      break;
    default:
      msgElement.style.color = "white";
  }
  
  // Clear after 3 seconds
  setTimeout(() => {
    if (msgElement.textContent === message) {
      msgElement.textContent = "";
    }
  }, 3000);
}

// Initialize the extension when the DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeExtension);
} else {
  initializeExtension();
}

