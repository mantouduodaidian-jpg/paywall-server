var app = getApp();
var PAGE_SIZE = 20;

Page({
  data: {
    user: null,
    cats: [],
    selCat: '',
    activeCatLabel: '全部',
    searchKeyword: '',
    tradeType: 'sell',
    sortBy: 'latest',
    minPrice: '',
    maxPrice: '',
    products: [],
    page: 0,
    totalCount: 0,
    totalPages: 0,
    loading: false,
    hasMore: true
  },

  onLoad() {
    this.loadCats();
    this.loadProducts(true);
    var u = app.globalData.user || wx.getStorageSync('user') || null;
    if (u) { app.globalData.user = u; this.setData({ user: u }); }
  },

  onShow() {
    var u = app.globalData.user;
    if (u !== this.data.user) this.setData({ user: u });
    if (app.globalData._needRefresh) {
      app.globalData._needRefresh = false;
      this.loadProducts(true);
    }
  },

  loadCats() {
    var self = this;
    app.request('/api/marketplace/categories').then(function (arr) {
      if (arr && arr.length) self.setData({ cats: arr });
    });
  },

  loadProducts(reset) {
    if (this.data.loading) return;
    if (!reset && !this.data.hasMore) return;
    var self = this;
    var page = reset ? 0 : this.data.page;
    var page2 = reset ? 0 : (this.data.page + 1);
    this.setData({ loading: true });

    var url = '/api/marketplace/products?limit=' + PAGE_SIZE + '&offset=' + (page * PAGE_SIZE);
    if (this.data.selCat && this.data.selCat !== '__my__' && this.data.selCat !== '__fav__') url += '&category=' + encodeURIComponent(this.data.selCat);
    if (this.data.searchKeyword) url += '&search=' + encodeURIComponent(this.data.searchKeyword);
    if (this.data.minPrice) url += '&minPrice=' + this.data.minPrice;
    if (this.data.maxPrice) url += '&maxPrice=' + this.data.maxPrice;
    if (this.data.tradeType === 'rent') url += '&trade_type=rent';
    if (this.data.selCat === '__my__' && this.data.user) url += '&owner=' + this.data.user.student_id;

    app.request(url).then(function (data) {
      var arr = data.products || data.data || data || [];
      if (!Array.isArray(arr)) arr = [];
      var total = data.total || arr.length;
      var tp = Math.ceil(total / PAGE_SIZE) || 1;
      self.setData({
        products: reset ? arr : self.data.products.concat(arr),
        page: page,
        totalCount: total,
        totalPages: tp,
        hasMore: (reset ? arr : self.data.products.concat(arr)).length < total,
        loading: false
      });
    }).catch(function () { self.setData({ loading: false }); });
  },

  setCat(e) {
    var val = e.currentTarget.dataset.cat;
    if (val === this.data.selCat) return;
    this.setData({ selCat: val });
    this.loadProducts(true);
  },

  onSearchInput(e) { this.setData({ searchKeyword: e.detail.value }); },
  onSearch() { this.loadProducts(true); },

  onTypeTap(e) {
    var type = e.currentTarget.dataset.type;
    if (type === this.data.tradeType) return;
    this.setData({ tradeType: type });
    this.loadProducts(true);
  },

  onSortTap() {
    this.setData({ sortBy: this.data.sortBy === 'latest' ? '' : 'latest' });
    this.loadProducts(true);
  },

  onMinPriceInput(e) { this.setData({ minPrice: e.detail.value }); },
  onMaxPriceInput(e) { this.setData({ maxPrice: e.detail.value }); },
  onFilterConfirm() { this.loadProducts(true); },

  onProductTap(e) {
    var id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  onLoginTap() { if (!this.data.user) wx.navigateTo({ url: '/pages/login/login' }); },
  onBetaTap() { wx.navigateTo({ url: '/pages/login/login?mode=beta' }); },

  onReachBottom() { if (this.data.hasMore) this.loadProducts(false); },
  onPullDownRefresh() { var self = this; this.loadProducts(true); setTimeout(function () { wx.stopPullDownRefresh(); }, 500); }
});
