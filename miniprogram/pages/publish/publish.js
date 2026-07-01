var app = getApp();

Page({
  data: {
    tradeType: 'sell',
    images: [],
    title: '',
    desc: '',
    category: '',
    categories: [],
    quality: '',
    qualities: ['全新', '几乎全新', '良好', '一般', '有瑕疵'],
    price: '',
    rentPrice: '',
    deposit: '',
    rentPeriod: '',
    rentPeriods: ['1个月', '3个月', '6个月', '12个月'],
    negotiable: false,
    genderPref: '',
    isEdit: false,
    editId: null,
    submitting: false
  },

  onLoad(e) {
    var self = this;
    // load categories
    app.request('/api/marketplace/categories').then(function (arr) {
      if (arr && arr.length) {
        self.setData({ categories: arr.map(function (c) { return c.name; }) });
      }
    });

    // check if editing
    if (e && e.edit) {
      this.setData({ isEdit: true, editId: e.edit });
      if (e.data) {
        try {
          var p = JSON.parse(decodeURIComponent(e.data));
          self.loadEditData(p);
        } catch (err) { }
      }
    }
  },

  loadEditData(p) {
    this.setData({
      tradeType: p.trade_type === 'rent' ? 'rent' : 'sell',
      title: p.title || '',
      desc: p.desc || '',
      category: p.category || '',
      quality: p.quality || '',
      price: p.price ? String(p.price) : '',
      rentPrice: p.rent_price ? String(p.rent_price) : '',
      deposit: p.deposit ? String(p.deposit) : '',
      rentPeriod: p.rent_period || '',
      negotiable: !!p.negotiable,
      genderPref: p.gender_pref || '',
      images: (p.images || []).map(function (img) { return 'https://paywall-server.onrender.com' + img; })
    });
  },

  switchType(e) {
    this.setData({ tradeType: e.currentTarget.dataset.type });
  },

  onInput(e) {
    var field = e.currentTarget.dataset.field;
    var val = e.detail.value;
    var obj = {};
    obj[field] = val;
    this.setData(obj);
  },

  onCategoryChange(e) {
    var idx = e.detail.value;
    this.setData({ category: this.data.categories[idx] });
  },

  onQualityChange(e) {
    var idx = e.detail.value;
    this.setData({ quality: this.data.qualities[idx] });
  },

  onRentPeriodChange(e) {
    var idx = e.detail.value;
    this.setData({ rentPeriod: this.data.rentPeriods[idx] });
  },

  toggleNegotiable() {
    this.setData({ negotiable: !this.data.negotiable });
  },

  setGenderPref(e) {
    this.setData({ genderPref: e.currentTarget.dataset.val });
  },

  addImage() {
    var self = this;
    wx.chooseImage({
      count: 6 - this.data.images.length,
      sizeType: ['compressed'],
      success: function (res) {
        var tempPaths = res.tempFilePaths;
        // Upload each image
        var uploaded = [];
        var done = 0;
        wx.showLoading({ title: '上传中...' });
        tempPaths.forEach(function (path) {
          wx.uploadFile({
            url: 'https://paywall-server.onrender.com/api/upload',
            filePath: path,
            name: 'file',
            success: function (r) {
              try {
                var d = JSON.parse(r.data);
                if (d && d.url) {
                  uploaded.push('https://paywall-server.onrender.com' + d.url);
                }
              } catch (e) { }
            },
            complete: function () {
              done++;
              if (done === tempPaths.length) {
                wx.hideLoading();
                self.setData({ images: self.data.images.concat(uploaded) });
              }
            }
          });
        });
      }
    });
  },

  removeImage(e) {
    var idx = e.currentTarget.dataset.index;
    var imgs = this.data.images.slice();
    imgs.splice(idx, 1);
    this.setData({ images: imgs });
  },

  submitProduct() {
    var d = this.data;
    if (!d.title) { wx.showToast({ title: '请输入物品名称', icon: 'none' }); return; }
    if (!d.category) { wx.showToast({ title: '请选择分类', icon: 'none' }); return; }
    if (d.tradeType === 'sell' && !d.price) { wx.showToast({ title: '请输入售价', icon: 'none' }); return; }
    if (d.tradeType === 'rent' && !d.rentPrice) { wx.showToast({ title: '请输入租价', icon: 'none' }); return; }

    var user = app.globalData.user;
    if (!user) { wx.navigateTo({ url: '/pages/login/login' }); return; }

    this.setData({ submitting: true });
    wx.showLoading({ title: '发布中...' });

    var body = {
      student_id: user.student_id,
      title: d.title,
      desc: d.desc,
      category: d.category,
      quality: d.quality,
      price: d.tradeType === 'sell' ? Number(d.price) : 0,
      trade_type: d.tradeType,
      rent_price: d.tradeType === 'rent' ? Number(d.rentPrice) : 0,
      deposit: d.tradeType === 'rent' ? Number(d.deposit || 0) : 0,
      rent_period: d.rentPeriod || '',
      negotiable: d.negotiable,
      gender_pref: d.genderPref || '',
      images: d.images.map(function (img) { return img.replace('https://paywall-server.onrender.com', ''); })
    };

    var self = this;
    var url, method;

    if (this.data.isEdit) {
      url = '/api/marketplace/products/' + this.data.editId + '/owner-edit';
      method = 'PATCH';
    } else {
      url = '/api/marketplace/products';
      method = 'POST';
    }

    app.request(url, method, body)
      .then(function (r) {
        wx.hideLoading();
        if (r && (r.id || r.ok)) {
          wx.showToast({ title: self.data.isEdit ? '修改成功' : '发布成功', icon: 'success' });
          app.globalData._needRefresh = true;
          setTimeout(function () { wx.navigateBack(); }, 1500);
        } else {
          wx.showToast({ title: r.error || '发布失败', icon: 'none' });
        }
      })
      .catch(function () {
        wx.hideLoading();
        wx.showToast({ title: '网络错误', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  }
});
