var app = getApp();
var PAGE_MAP = ['pages/index/index', 'pages/message/message', 'pages/publish/publish', 'pages/profile/profile'];
Component({
  data: { selected: 0, list: [
    { iconPath: '/images/tab-home.png', selectedIconPath: '/images/tab-home-active.png', text: '首页' },
    { iconPath: '/images/tab-msg.png', selectedIconPath: '/images/tab-msg-active.png', text: '消息' },
    { iconPath: '/images/tab-pub.png', selectedIconPath: '/images/tab-pub-active.png', text: '发布' },
    { iconPath: '/images/tab-me.png', selectedIconPath: '/images/tab-me-active.png', text: '我的' }
  ]},
  lifetimes: {
    attached() {
      var p = getCurrentPages();
      var cur = p[p.length - 1];
      if (cur) {
        var route = cur.route || '';
        var idx = PAGE_MAP.indexOf(route);
        if (idx >= 0) this.setData({ selected: idx });
      }
    }
  },
  methods: {
    switchTab(e) {
      var idx = e.currentTarget.dataset.idx;
      wx.switchTab({ url: '/' + PAGE_MAP[idx] });
    }
  }
});
