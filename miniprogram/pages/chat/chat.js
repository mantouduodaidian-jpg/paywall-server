const app = getApp();
const API_BASE = 'https://paywall-server.onrender.com';
const REVIEW_TAGS = ['商品与描述一致', '沟通态度好', '准时到达', '商品完好', '价格合理', '交易顺利', '与描述不符', '沟通不愉快'];
Page({
  data: { msgs: [], input: '', user: null, pid: 0, sid: '', name: '', _loaded: false,
    product: null, tradeRole: '', tradeStatus: '', tradeProducts: [], tradePicker: [], tradeIdx: -1,
    otherNick: '', otherGender: '', msgTopId: '', pendingImg: '',
    showReview: false, reviewTags: [], reviewSel: [], reviewText: '', reviewImgs: [] },
  _tradeTimer: null,
  goBack() {
    try { wx.navigateBack({ delta: 1 }); } catch(e) {
      wx.switchTab({ url: '/pages/message/message' });
    }
  },
  onLoad(opt) {
    if (this._tradeTimer) { clearTimeout(this._tradeTimer); this._tradeTimer = null; }
    this.setData({ tradeProducts: [], tradePicker: [], tradeIdx: -1 });
    const user = app.globalData.user || wx.getStorageSync('user');
    this.data.pid = parseInt(opt.pid);
    this.data.sid = opt.sid;
    this.data.name = decodeURIComponent(opt.name || '');
    this.setData({ user, pid: this.data.pid, sid: this.data.sid, name: this.data.name });
    // Load messages immediately (non-blocking)
    this.loadMsgs();
    // Load product and nickname in parallel
    this.loadProduct();
    this.loadNickname();
    // Load trades in background (non-blocking)
    this._tradeTimer = setTimeout(function() { this._tradeTimer = null; this.loadTrades(); }.bind(this), 500);
    // Listen for WebSocket real-time messages
    this._wsHandler = function(data, type) {
      if (type === 'chat' && data) {
        var msg = data.data || data;
        if ((msg.from_student_id === this.data.sid || msg.to_student_id === this.data.sid) && msg.from_student_id !== this.data.user.student_id) {
          var msgs = this.data.msgs.concat([this.processMsg({ ...msg, time: (msg.created_at||'').substring(11,16), mine: false })]);
          this.setData({ msgs });
          app.playSound('msg');
        }
      }
    }.bind(this);
    app.onWS('chat', this._wsHandler);
  },
  loadNickname(retries) {
    if (!retries) retries = 0;
    app.getNickCache(retries > 0).then(function(cache) {
      var nick = cache[this.data.sid];
      if (nick) { this.data.name = nick; this.setData({ name: nick }); wx.setNavigationBarTitle({ title: nick }); }
    }.bind(this)).catch(function() {
      if (retries < 3) setTimeout(function() { this.loadNickname(retries + 1); }.bind(this), 2000);
    }.bind(this));
  },
  loadProduct() {
    app.request('/api/marketplace/products/' + this.data.pid).then(p => {
      if (!p) return;
      this.setData({ product: p });
      // Determine trade role
      let role = '';
      if (p.owner_student_id === this.data.user.student_id) role = 'seller';
      else if (p.trade_buyer_id === this.data.user.student_id) role = 'buyer';
      this.setData({ tradeRole: role, tradeStatus: p.trade_status || '' });
      this.updateOtherInfo(p);
    });
  },
  loadMsgs() {
    const d = this.data;
    app.request('/api/marketplace/messages?student_id=' + d.user.student_id + '&other_student_id=' + d.sid)
      .then(data => {
        const arr = Array.isArray(data) ? data : [];
        // Play sound for new incoming messages (skip first load)
        var hasNew = this.data._loaded && arr.length > this.data.msgs.length && arr.slice(-1)[0] && arr.slice(-1)[0].from_student_id !== d.user.student_id;
        if (hasNew) app.playSound('msg');
        const msgs = arr.map(m => this.processMsg({
          ...m,
          time: (m.created_at || '').substring(11, 16),
          mine: m.from_student_id === d.user.student_id
        }));
        this.setData({ msgs, _loaded: true, msgTopId: msgs.length ? msgs[msgs.length - 1].id : '' });
        app.request('/api/marketplace/messages/read', 'POST', { from_student_id: d.sid, student_id: d.user.student_id });
      });
  },
  loadTrades(cb) {
    // Load products traded between current user and chat partner
    var u = this.data.user;
    var otherId = this.data.sid;
    if (!u || !otherId) return;
    otherId = String(otherId);
    Promise.all([
      app.request('/api/marketplace/products?owner=' + u.student_id + '&limit=50'),
      app.request('/api/marketplace/products?owner=' + this.data.sid + '&limit=50')
    ]).then(function(results) {
      var all = [];
      results.forEach(function(r) {
        var arr = r.data || r || [];
        if (Array.isArray(arr)) all = all.concat(arr);
      });
      // Filter: only trades involving BOTH users
      var myId = String(u.student_id);
      var seen = {};
      var traded = all.filter(function(p) {
        if (!p.trade_status || seen[p.id]) return false;
        seen[p.id] = true;
        var o = String(p.owner_student_id || ''), b = String(p.trade_buyer_id || '');
        // Both users must be involved (one is owner, other is buyer)
        return (o === myId && b === otherId) || (o === otherId && b === myId);
      });
      if (traded.length <= 1) return;
      var picker = traded.map(function(p) {
        var statusMap = { trading: '⏳等待', awaiting_buyer: '📦确认', completed: '✅完成' };
        return (statusMap[p.trade_status] || '') + ' ' + p.title;
      });
      this.setData({ tradeProducts: traded, tradePicker: picker, tradeIdx: -1 });
      if (cb) cb();
    }.bind(this)).catch(function(){ if (cb) cb(); });
  },
  showTradePicker() {
    var self = this;
    if (!this.data.tradePicker.length) {
      wx.showLoading({ title: '加载中' });
      this.loadTrades(function() {
        wx.hideLoading();
        if (self.data.tradePicker.length > 1) {
          wx.showActionSheet({ itemList: self.data.tradePicker, success: function(e) { self.switchTrade(e.tapIndex); } });
        }
      });
      return;
    }
    if (this.data.tradePicker.length > 1) {
      wx.showActionSheet({ itemList: this.data.tradePicker, success: function(e) { self.switchTrade(e.tapIndex); } });
    }
  },
  switchTrade(idx) {
    var p = this.data.tradeProducts[idx];
    if (!p) return;
    this.setData({ pid: p.id, product: p, tradeIdx: idx });
    // Update trade status
    var role = '';
    if (p.owner_student_id === this.data.user.student_id) role = 'seller';
    else if (p.trade_buyer_id === this.data.user.student_id) role = 'buyer';
    this.setData({ tradeRole: role, tradeStatus: p.trade_status || '' });
    this.updateOtherInfo(p);
    // Reload messages for this product
    this.loadMsgs();
  },
  updateOtherInfo(p) {
    if (!p) return;
    // Ensure nick cache is loaded
    if (!Object.keys(app.globalData.nickCache || {}).length) {
      app.getNickCache().then(function() { this.updateOtherInfo(p); }.bind(this));
      return;
    }
    var cache = app.globalData.nickCache || {};
    var genderCache = app.globalData.genderCache || {};
    var otherSid = '';
    if (this.data.tradeRole === 'seller') otherSid = p.trade_buyer_id;
    else if (this.data.tradeRole === 'buyer') otherSid = p.owner_student_id;
    // Only show other party's info if they match the chat partner
    if (otherSid && String(otherSid) === String(this.data.sid)) {
      var nick = cache[otherSid] || '';
      var gender = genderCache[otherSid] || '';
      this.setData({ otherNick: nick, otherGender: ({male:'♂️',female:'♀️',男:'♂️',女:'♀️'})[gender] || '' });
    } else {
      this.setData({ otherNick: '', otherGender: '' });
    }
  },
  onPullDownRefresh() { this.loadMsgs(); wx.stopPullDownRefresh(); },
  onUnload() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._wsHandler) app.offWS('chat');
    if (this._tradeTimer) { clearTimeout(this._tradeTimer); this._tradeTimer = null; }
  },
  onInput(e) { this.setData({ input: e.detail.value }); },
  // Parse [img] markers into renderable parts
  processMsg(m) {
    var content = m.content || '';
    var hasImg = content.indexOf('[img]') >= 0;
    if (!hasImg) return { ...m, _hasImg: false };
    var msgId = m.id;
    var raw = content.split('[img]');
    var parts = raw.map(function(v, i) {
      if (i === 0) return { isImg: false, val: v };
      return { isImg: true, val: API_BASE + '/api/chat-image/' + msgId };
    });
    return { ...m, _hasImg: true, _parts: parts };
  },
  pickChatImg() {
    wx.chooseImage({ count: 1, sizeType: ['compressed'],
      success: res => {
        wx.compressImage({ src: res.tempFilePaths[0], quality: 60,
          success: cp => {
            var b64 = wx.getFileSystemManager().readFileSync(cp.tempFilePath, 'base64');
            this.setData({ pendingImg: 'data:image/jpeg;base64,' + b64 });
          },
          fail: () => {
            var b64 = wx.getFileSystemManager().readFileSync(res.tempFilePaths[0], 'base64');
            this.setData({ pendingImg: 'data:image/jpeg;base64,' + b64 });
          }
        });
      }
    });
  },
  clearPendingImg() { this.setData({ pendingImg: '' }); },
  sendMsg() {
    const d = this.data;
    if (!d.input.trim() && !d.pendingImg) return;
    app.getNickCache().then(function(cache) {
      var nick = cache[d.user.student_id] || d.user.name;
      var content = d.input.trim();
      if (d.pendingImg) content = '[img]' + d.pendingImg + (content ? '\n' + content : '');
      app.request('/api/marketplace/messages', 'POST', {
        product_id: d.pid, from_student_id: d.user.student_id, from_name: nick,
        to_student_id: d.sid, to_name: d.name, content: content
      }).then(() => {
        this.setData({ input: '', pendingImg: '' });
        this.loadMsgs();
      });
    }.bind(this));
  },
  // === Trade actions ===
  goDetail() {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + this.data.pid });
  },
  confirmTrade() {
    wx.showLoading({ title: '处理中' });
    app.request('/api/marketplace/trade/confirm', 'POST', {
      product_id: this.data.pid, seller_id: this.data.user.student_id
    }).then(d => {
      wx.hideLoading();
      if (d.ok) {
        app.toast('已确认交易', 'success');
        this.setData({ tradeStatus: 'awaiting_buyer' });
        this.updateOtherInfo(this.data.product);
        this.loadMsgs();
      } else {
        app.toast(d.error || '操作失败');
      }
    }).catch(() => wx.hideLoading());
  },
  cancelTrade() {
    wx.showLoading({ title: '处理中' });
    app.request('/api/marketplace/trade/cancel', 'POST', {
      product_id: this.data.pid, student_id: this.data.user.student_id
    }).then(d => {
      wx.hideLoading();
      if (d.ok) {
        app.toast('已取消交易');
        this.setData({ tradeStatus: '' });
        this.loadMsgs();
      } else {
        app.toast(d.error || '操作失败');
      }
    }).catch(() => wx.hideLoading());
  },
  receiveGoods() {
    wx.showLoading({ title: '处理中' });
    app.request('/api/marketplace/trade/buyer-confirm', 'POST', {
      product_id: this.data.pid, buyer_id: this.data.user.student_id
    }).then(d => {
      wx.hideLoading();
      if (d.ok) {
        app.toast('已确认收货', 'success');
        this.setData({ tradeStatus: 'completed' });
        this.loadMsgs();
        // Show review modal
        this.setData({ showReview: true, reviewTags: REVIEW_TAGS, reviewSel: [], reviewText: '', reviewImgs: [] });
      } else {
        app.toast(d.error || '操作失败');
      }
    }).catch(() => wx.hideLoading());
  },
  // Review
  toggleReviewTag(e) {
    var tag = e.currentTarget.dataset.tag;
    var sel = this.data.reviewSel.slice();
    var idx = sel.indexOf(tag);
    if (idx >= 0) sel.splice(idx, 1); else sel.push(tag);
    this.setData({ reviewSel: sel });
  },
  onReviewText(e) { this.setData({ reviewText: e.detail.value }); },
  pickReviewImg() {
    wx.chooseImage({ count: 3, sizeType: ['compressed'],
      success: res => {
        var imgs = this.data.reviewImgs.slice();
        res.tempFilePaths.forEach(function(p) { if (imgs.length < 3) imgs.push(p); });
        this.setData({ reviewImgs: imgs });
      }
    });
  },
  delReviewImg(e) {
    var imgs = this.data.reviewImgs.slice();
    imgs.splice(e.currentTarget.dataset.index, 1);
    this.setData({ reviewImgs: imgs });
  },
  submitReview() {
    var d = this.data;
    if (!d.reviewText) return app.toast('请填写评价理由');
    wx.showLoading({ title: '提交中' });
    app.request('/api/marketplace/reviews', 'POST', {
      product_id: this.data.pid,
      buyer_id: this.data.user.student_id,
      seller_id: this.data.sid,
      tags: d.reviewSel,
      reason: d.reviewText,
      images: d.reviewImgs.map(function(p) {
        try { return 'data:image/jpeg;base64,' + wx.getFileSystemManager().readFileSync(p, 'base64'); } catch(e) { return ''; }
      }).filter(Boolean)
    }).then(function(r) {
      wx.hideLoading();
      if (r && r.ok) app.toast('评价已提交', 'success');
      else app.toast('提交失败');
      this.setData({ showReview: false });
    }.bind(this)).catch(function() { wx.hideLoading(); app.toast('网络错误'); this.setData({ showReview: false }); }.bind(this));
  },
  closeReview() { this.setData({ showReview: false }); }
});
