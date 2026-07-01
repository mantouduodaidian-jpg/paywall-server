const app = getApp();
const SCHOOLS = [
  { code: 'gxny', name: '广西农业职业技术大学' },
  { code: 'hnkj', name: '海南科技职业大学' },
  { code: 'gdcj', name: '广东财经大学' },
  { code: 'lztd', name: '柳州铁道职业技术学院' },
  { code: 'beta',  name: '🛠 内测服' },
];
const PAGE_SIZE = 10;
const SORT_VALS = ['', 'oldest', 'price_asc', 'price_desc'];

Page({
  data: {
    // Products
    list: [],
    page: 0,
    hasMore: true,
    total: 0,
    totalPages: 0,
    pages: [],
    resultLabel: '加载中...',

    // Categories
    cats: [],
    selCat: '',

    // Item type
    itemType: 'sell',
    itemTypeLabels: { sell: '出售', buy: '求购', rent: '租赁' },
    itemTypeIcons: { sell: '🛒', buy: '📋', rent: '📦' },

    // Search
    search: '',

    // User & School
    user: null,
    schools: SCHOOLS,
    schoolCode: '',
    schoolName: '全部学校',
    showSchool: false,

    // Announcements
    announcements: [],
    annText: '',
    annLink: '',
    annShow: false,

    // Sort & Filter
    sortOpts: ['最新', '最旧', '价格从低到高', '价格从高到低'],
    sortIdx: 0,
    sortVal: '',
    priceMin: '',
    priceMax: '',
    showFilter: false,
  },

  onLoad() {
    const user = app.globalData.user || wx.getStorageSync('user') || null;
    this.setUserSchool(user);
    this.loadCats();
    this.loadData();
    this.loadAnnouncements();
  },

  onShow() {
    const user = app.globalData.user || wx.getStorageSync('user') || null;
    const prevUser = this.data.user;
    const userChanged = (user && prevUser && user.student_id !== prevUser.student_id) || (!user && prevUser) || (user && !prevUser);
    if (userChanged) {
      this.setUserSchool(user);
    }
    if (app.globalData._needRefresh) {
      app.globalData._needRefresh = false;
      this.setData({ page: 0, list: [], hasMore: true, pages: [], resultLabel: '加载中...' });
      this.loadData();
    }
    this.loadAnnouncements();
  },

  // ───── Categories ─────
  loadCats() {
    app.request('/api/marketplace/categories').then(res => {
      const arr = (res && (res.data || res)) || [];
      if (Array.isArray(arr)) {
        this.setData({ cats: arr });
      }
    }).catch(() => {});
  },

  // ───── Products ─────
  loadData() {
    const { page, hasMore, list } = this.data;
    if (!hasMore && page > 0) return;

    wx.showLoading({ title: '加载中...', mask: true });

    const params = {
      page,
      size: PAGE_SIZE,
      itemType: this.data.itemType,
    };

    // Apply category filter
    const cat = this.data.selCat;
    if (cat === '__my__') {
      const user = this.data.user;
      if (user) params.owner = user.student_id;
    } else if (cat === '__fav__') {
      params.favorite = 'true';
    } else if (cat) {
      params.category = cat;
    }

    // Apply school filter
    if (this.data.schoolCode) {
      params.schoolCode = this.data.schoolCode;
    }

    // Apply search
    if (this.data.search) {
      params.search = this.data.search;
    }

    // Apply sort
    if (this.data.sortVal) {
      params.sort = this.data.sortVal;
    }

    // Apply price range
    if (this.data.priceMin) {
      params.priceMin = this.data.priceMin;
    }
    if (this.data.priceMax) {
      params.priceMax = this.data.priceMax;
    }

    // Build query string
    const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');

    app.request('/api/marketplace/products?' + qs).then(res => {
      wx.hideLoading();
      wx.stopPullDownRefresh();

      if (!res) {
        this.setData({ resultLabel: '暂无商品', hasMore: false });
        return;
      }

      // Handle various response shapes
      let records = null;
      let total = 0;
      if (res.data && Array.isArray(res.data.records)) {
        records = res.data.records;
        total = res.data.total || res.data.totalElements || records.length;
      } else if (res.data && Array.isArray(res.data.content)) {
        records = res.data.content;
        total = res.data.total || res.data.totalElements || records.length;
      } else if (Array.isArray(res.data)) {
        records = res.data;
        total = res.data.length;
      } else if (Array.isArray(res)) {
        records = res;
        total = res.length;
      }

      if (records) {
        const newList = page === 0 ? records : list.concat(records);
        const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
        const more = page + 1 < totalPages;
        const label = total > 0 ? '共 ' + total + ' 件商品' : '暂无商品';

        this.setData({
          list: newList,
          total,
          totalPages,
          hasMore: more,
          resultLabel: label,
        });
      } else {
        this.setData({ resultLabel: '暂无商品', hasMore: false });
      }
    }).catch(err => {
      wx.hideLoading();
      wx.stopPullDownRefresh();
      this.setData({ resultLabel: '加载失败，下拉刷新重试' });
      console.error(err);
    });
  },

  // ───── Announcements ─────
  loadAnnouncements() {
    app.request('/api/marketplace/announcements').then(res => {
      const arr = (res && (res.data || res)) || [];
      if (Array.isArray(arr) && arr.length > 0) {
        const texts = arr.map(a => a.title || a.content || '').filter(Boolean);
        this.setData({
          announcements: arr,
          annText: texts.join('  ·  '),
          annLink: arr[0].link || '',
          annShow: true,
        });
      } else {
        this.setData({ annShow: false });
      }
    }).catch(() => {});
  },

  // ───── School Filter ─────
  toggleSchool() {
    if (this.data.user) return;
    this.setData({ showSchool: !this.data.showSchool });
  },

  getUserSchool(user) {
    if (user && user.school) {
      const school = SCHOOLS.find(s => s.code === user.school);
      return { code: user.school, name: school ? school.name : '' };
    }
    const saved = wx.getStorageSync('visitorSchool');
    if (saved) {
      const school = SCHOOLS.find(s => s.code === saved);
      if (school) return { code: school.code, name: school.name };
    }
    return { code: '', name: '全部学校' };
  },

  setUserSchool(user) {
    const { code, name } = this.getUserSchool(user);
    this.setData({ user, schoolCode: code, schoolName: name });
  },

  pickSchool(e) {
    const code = e.currentTarget.dataset.code;
    if (code === undefined && code === null) return;
    const school = SCHOOLS.find(s => s.code === code);
    wx.setStorageSync('visitorSchool', code);
    this.setData({
      schoolCode: code,
      schoolName: school ? school.name : '全部学校',
      showSchool: false,
      page: 0,
      list: [],
      hasMore: true,
      pages: [],
      resultLabel: '加载中...',
    });
    this.loadData();
  },

  // ───── Category Selection ─────
  setCat(e) {
    let cat = e.currentTarget.dataset.cat;
    if (cat === 'my') {
      if (!this.data.user) {
        wx.navigateTo({ url: '/pages/login/login' });
        return;
      }
      cat = '__my__';
    } else if (cat === 'fav') {
      if (!this.data.user) {
        wx.navigateTo({ url: '/pages/login/login' });
        return;
      }
      cat = '__fav__';
    }
    const newCat = this.data.selCat === cat ? '' : cat;
    this.setData({
      selCat: newCat,
      page: 0,
      list: [],
      hasMore: true,
      pages: [],
      resultLabel: '加载中...',
    });
    this.loadData();
  },

  // ───── Search ─────
  onSearch(e) {
    const val = (e.detail.value || '').trim();
    this.setData({
      search: val,
      page: 0,
      list: [],
      hasMore: true,
      pages: [],
      resultLabel: '加载中...',
    });
    this.loadData();
  },

  clearSearch() {
    this.setData({
      search: '',
      page: 0,
      list: [],
      hasMore: true,
      pages: [],
      resultLabel: '加载中...',
    });
    this.loadData();
  },

  // ───── Sort ─────
  onSort(e) {
    const idx = parseInt(e.detail.value, 10);
    this.setData({
      sortIdx: idx,
      sortVal: SORT_VALS[idx] || '',
      page: 0,
      list: [],
      hasMore: true,
      pages: [],
      resultLabel: '加载中...',
    });
    this.loadData();
  },

  // ───── Price Filter ─────
  onPriceMin(e) { this.setData({ priceMin: e.detail.value }); },
  onPriceMax(e) { this.setData({ priceMax: e.detail.value }); },

  applyFilter() {
    this.setData({
      showFilter: false,
      page: 0,
      list: [],
      hasMore: true,
      pages: [],
      resultLabel: '加载中...',
    });
    this.loadData();
  },

  // ───── Item Type Toggle ─────
  toggleItemType() {
    const types = ['sell', 'buy', 'rent'];
    const curIdx = types.indexOf(this.data.itemType);
    const next = types[(curIdx + 1) % types.length];
    this.setData({
      itemType: next,
      page: 0,
      list: [],
      hasMore: true,
      pages: [],
      resultLabel: '加载中...',
    });
    this.loadData();
  },

  // ───── Navigation ─────
  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  goProfile() {
    if (this.data.user) {
      wx.switchTab({ url: '/pages/profile/profile' });
    } else {
      wx.navigateTo({ url: '/pages/login/login' });
    }
  },

  goAnnouncement() {
    const link = this.data.annLink;
    if (link) {
      wx.setClipboardData({ data: link });
    }
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  // ───── Pagination ─────
  onReachBottom() {
    if (!this.data.hasMore) return;
    const nextPage = this.data.page + 1;
    if (nextPage < this.data.totalPages) {
      this.setData({ page: nextPage }, () => { this.loadData(); });
    }
  },

  // ───── Pull to Refresh ─────
  onPullDownRefresh() {
    this.setData({
      page: 0,
      list: [],
      hasMore: true,
      pages: [],
      resultLabel: '加载中...',
    });
    this.loadData();
    this.loadAnnouncements();
  },

  // ───── Filter Popup ─────
  toggleFilter() {
    this.setData({ showFilter: !this.data.showFilter });
  },
});
