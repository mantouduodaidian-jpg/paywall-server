const app = getApp();

Page({
  data: {
    contacts: [],
    user: null,
    loading: true,
  },

  onLoad() {
    const user = app.globalData.user || wx.getStorageSync('user') || null;
    this.setData({ user });
    if (user) {
      this.loadContacts();
    } else {
      this.setData({ loading: false });
    }
  },

  onShow() {
    const user = app.globalData.user || wx.getStorageSync('user') || null;
    const prev = this.data.user;
    const changed = (user && prev && user.student_id !== prev.student_id) || (!user && prev) || (user && !prev);
    if (changed) {
      this.setData({ user });
      if (user) {
        this.loadContacts();
      } else {
        this.setData({ contacts: [], loading: false });
      }
    } else if (user) {
      this.loadContacts();
    }
  },

  loadContacts() {
    if (!this.data.user) return;
    this.setData({ loading: true });

    app.request('/api/marketplace/contacts').then(res => {
      const arr = (res && (res.data || res)) || [];
      const contacts = Array.isArray(arr) ? arr.map(c => ({
        ...c,
        lastTime: this.formatTime(c.last_time || c.last_message_time || c.updated_at || ''),
        _hasUnread: c.unread > 0,
      })) : [];
      this.setData({ contacts, loading: false });
      wx.stopPullDownRefresh();
    }).catch(() => {
      this.setData({ loading: false });
      wx.stopPullDownRefresh();
    });
  },

  formatTime(timeStr) {
    if (!timeStr) return '';
    try {
      const d = new Date(timeStr);
      if (isNaN(d.getTime())) return timeStr.substring(0, 10) || '';
      const now = new Date();
      const diff = now - d;
      const oneDay = 86400000;
      if (diff < oneDay && d.getDate() === now.getDate()) {
        return timeStr.substring(11, 16);
      }
      if (diff < 2 * oneDay && d.getDate() === now.getDate() - 1) {
        return '昨天';
      }
      if (diff < 7 * oneDay) {
        const days = ['周日','周一','周二','周三','周四','周五','周六'];
        return days[d.getDay()];
      }
      return timeStr.substring(0, 10);
    } catch (e) {
      return timeStr.substring(0, 10) || '';
    }
  },

  goChat(e) {
    const user = this.data.user;
    if (!user) {
      wx.navigateTo({ url: '/pages/login/login' });
      return;
    }
    const c = e.currentTarget.dataset.contact;
    if (!c || !c.student_id) return;
    wx.navigateTo({
      url: '/pages/chat/chat?pid=' + (c.product_id || 0) + '&sid=' + c.student_id + '&name=' + encodeURIComponent(c.name || '')
    });
  },

  onPullDownRefresh() {
    if (this.data.user) {
      this.loadContacts();
    } else {
      wx.stopPullDownRefresh();
    }
  },
});
