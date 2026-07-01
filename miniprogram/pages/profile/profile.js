const app = getApp();
const SCHOOLS = [
  { code: 'gxny', name: '广西农业职业技术大学' },
  { code: 'hnkj', name: '海南科技职业大学' },
  { code: 'gdcj', name: '广东财经大学' },
  { code: 'lztd', name: '柳州铁道职业技术学院' },
  { code: 'beta', name: '🛠 内测服' },
];

Page({
  data: { user: null, schoolName: '', showPicker: false, schools: SCHOOLS, soundOn: true },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ active: 3 });
    }
    const user = app.globalData.user || wx.getStorageSync('user');
    if (user) {
      const s = SCHOOLS.find(s => s.code === user.school);
      this.setData({ user, schoolName: s ? s.name : '' });
    }
    this.setData({ soundOn: app._soundEnabled !== false });
  },
  toggleSound() {
    var on = !app._soundEnabled;
    if (on) {
      try { // 开启时响一声
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
    if (user) { const s = SCHOOLS.find(s => s.code === user.school); this.setData({ user, schoolName: s ? s.name : '' }); }
    wx.stopPullDownRefresh();
  },
  showSchoolPicker() { this.setData({ showPicker: true }); },
  hideSchoolPicker() { this.setData({ showPicker: false }); },
  pickSchool(e) {
    const code = e.currentTarget.dataset.code;
    const user = this.data.user;
    if (user.school === 'beta' && code !== 'beta') return app.toast('内测账号不可切换学校');
    const s = SCHOOLS.find(s => s.code === code);
    user.school = code;
    app.globalData.user = user;
    wx.setStorageSync('user', user);
    wx.setStorageSync('userSchool', code);
    this.setData({ user, schoolName: s ? s.name : '', showPicker: false });
    app.globalData._needRefresh = true;
    app.toast('学校已设置');
  },
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
  }
});
