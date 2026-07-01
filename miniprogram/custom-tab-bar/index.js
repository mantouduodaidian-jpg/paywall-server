var PAGE_MAP = ['pages/index/index', 'pages/message/message', 'pages/publish/publish', 'pages/profile/profile'];
Component({
  data: { selected: 0 },
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
