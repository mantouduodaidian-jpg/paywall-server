const API_BASE = 'https://paywall-server.onrender.com';
const _wsHandlers = {};
var _ws = null, _wsTimer = null, _wsReconnect = 0;

App({
  globalData: { user: null, token: null, nickCache: null, genderCache: null, _needRefresh: false },
  onLaunch() {
    var u = wx.getStorageSync('user') || null;
    var t = wx.getStorageSync('token') || '';
    if (u) { this.globalData.user = u; this.globalData.token = t; this.connectWS(); }
  },
  toast(msg, type) {
    wx.showToast({ title: msg, icon: type === 'success' ? 'success' : 'none', duration: 2000 });
  },
  request(url, method, body) {
    var token = this.globalData.token || wx.getStorageSync('token') || '';
    return new Promise(function(resolve, reject) {
      wx.request({
        url: API_BASE + url,
        method: method || 'GET',
        data: body,
        header: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' },
        success: function(r) { resolve(r.data); },
        fail: function(e) { reject(e); }
      });
    });
  },
  connectWS() {
    var self = this;
    if (_ws) try { _ws.close(); } catch(e) {}
    try {
      _ws = wx.connectSocket({ url: 'wss://paywall-server.onrender.com' });
      _ws.onOpen(function() {
        _wsReconnect = 0;
        var u = self.globalData.user;
        if (u) _ws.send(JSON.stringify({ type: 'auth', student_id: u.student_id }));
      });
      _ws.onMessage(function(res) {
        try {
          var d = JSON.parse(res.data);
          if (d.type && _wsHandlers[d.type]) {
            _wsHandlers[d.type].forEach(function(h) { try { h(d.data, d.type); } catch(e) {} });
          }
        } catch(e) {}
      });
      _ws.onClose(function() {
        _ws = null;
        if (_wsReconnect < 5) {
          _wsReconnect++;
          setTimeout(function() { self.connectWS(); }, 3000 * _wsReconnect);
        }
      });
      _ws.onError(function() {});
    } catch(e) {}
  },
  disconnectWS() {
    _wsReconnect = 5;
    if (_ws) try { _ws.close(); } catch(e) {}
    _ws = null;
  },
  getNickCache(forceRefresh) {
    var self = this;
    return new Promise(function(resolve) {
      if (self.globalData.nickCache && !forceRefresh) { resolve(self.globalData.nickCache); return; }
      self.request('/api/marketplace/nicknames').then(function(d) {
        self.globalData.nickCache = d || {};
        resolve(self.globalData.nickCache);
      }).catch(function() { resolve(self.globalData.nickCache || {}); });
    });
  },
  onWS(type, handler) {
    if (!_wsHandlers[type]) _wsHandlers[type] = [];
    _wsHandlers[type].push(handler);
  },
  offWS(type) {
    delete _wsHandlers[type];
  },
  playSound(name) {
    try {
      var m = wx.createInnerAudioContext();
      m.src = 'sounds/' + name + '.wav';
      m.play();
    } catch(e) {}
  }
});
