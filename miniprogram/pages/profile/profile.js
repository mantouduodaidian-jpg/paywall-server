const app = getApp();
const SCHOOLS = [
  { code: 'gxny', name: '广西农业职业技术大学' },
  { code: 'hnkj', name: '海南科技职业大学' },
  { code: 'gdcj', name: '广东财经大学' },
  { code: 'lztd', name: '柳州铁道职业技术学院' },
  { code: 'beta', name: '🛠 内测服' },
];

Page({
  data: { user: null, schoolName: '', avatarLetter: '?', showPicker: false, schools: SCHOOLS, soundOn: true, creditScore: 80, creditHint: '信用分会根据平台处理结果动态调整', showCreditLogs: false, creditLogs: [], creditLogsLoading: false },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3, showMessageDot: !!app.globalData.messageTabDot });
    }
    const user = app.globalData.user || wx.getStorageSync('user');
    if (user) {
      const s = SCHOOLS.find(s => s.code === user.school);
      this.setData({ user, schoolName: s ? s.name : '', avatarLetter: (user.name || '?')[0] });
      var self = this;
      app.request('/api/marketplace/credit?student_id=' + encodeURIComponent(user.student_id || '')).then(function(d) {
        self.setData({ creditScore: d && d.credit_score ? d.credit_score : 80 });
      }).catch(function() {
        self.setData({ creditScore: 80 });
      });
    }
    this.setData({ soundOn: app._soundEnabled !== false });
    if (user && typeof app.refreshMessageDot === 'function') app.refreshMessageDot(user.student_id);
  },
  loadCreditLogs() {
    if (!this.data.user) return;
    this.setData({ creditLogsLoading: true });
    app.request('/api/marketplace/credit/logs?limit=20&student_id=' + encodeURIComponent(this.data.user.student_id || ''))
      .then(function(res) {
        var arr = Array.isArray(res) ? res : [];
        arr = arr.map(function(item) {
          var detail = String(item.detail || '');
          var deltaMatch = detail.match(/^([+-]\d+)/);
          var deltaText = deltaMatch ? deltaMatch[1] : '';
          var reason = detail.replace(/^([+-]\d+)\s*原因:/, '').trim();
          return Object.assign({}, item, {
            deltaText: deltaText,
            reasonText: reason || '管理员调整',
            timeText: item.created_at ? String(item.created_at).replace('T', ' ').substring(0, 16) : ''
          });
        });
        this.setData({ creditLogs: arr, creditLogsLoading: false, showCreditLogs: true });
      }.bind(this))
      .catch(function() {
        this.setData({ creditLogs: [], creditLogsLoading: false, showCreditLogs: true });
      }.bind(this));
  },
  hideCreditLogs() {
    this.setData({ showCreditLogs: false });
  },
  toggleSound() {
    var on = !app._soundEnabled;
    if (on) {
      try {
        var ctx = wx.createInnerAudioContext();
        ctx.obeyMuteSwitch = false;
        ctx.src = '/sounds/notif.wav';
        ctx.play();
      } catch(e) {}
    }
    app._soundEnabled = on;
    this.setData({ soundOn: on });
    app.toast(on ? '提示音已开启' : '提示音已关闭');
  },
  onPullDownRefresh() {
    const user = app.globalData.user || wx.getStorageSync('user');
    if (user) { const s = SCHOOLS.find(s => s.code === user.school); this.setData({ user, schoolName: s ? s.name : '', avatarLetter: (user.name || '?')[0] }); }
    wx.stopPullDownRefresh();
  },
  showSchoolPicker() {},
  hideSchoolPicker() {},
  pickSchool() {},
  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },
  doLogout() {
    wx.showModal({
      title: '提示',
      content: '确定退出登录？',
      success: res => {
        if (res.confirm) {
          app.globalData.user = null;
          app.globalData.token = null;
          app.disconnectWS();
          wx.removeStorageSync('user');
          this.setData({ user: null, schoolName: '' });
          app.toast('已退出');
        }
      }
    });
  },
  goMyProducts() {
    if (!this.data.user) return app.toast('请先登录');
    app.globalData.tabIntent = 'mine';
    wx.switchTab({ url: '/pages/index/index' });
  },
  goMyFavs() {
    if (!this.data.user) return app.toast('请先登录');
    app.globalData.tabIntent = 'fav';
    wx.switchTab({ url: '/pages/index/index' });
  },
  goMyPurchases() {
    if (!this.data.user) return app.toast('请先登录');
    wx.navigateTo({ url: '/pages/purchase/purchase' });
  },
});
