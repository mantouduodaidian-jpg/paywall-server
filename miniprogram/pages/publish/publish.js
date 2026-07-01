const app = getApp();
var QUALITIES = ['全新', '99新', '95新', '9成新', '8成新', '7成新', '6成新及以下'];
var PERIODS = [{v:'day',l:'/天'},{v:'week',l:'/周'},{v:'month',l:'/月'}];
Page({
  data: {
    isEdit: false, editId: 0, wasRejected: false,
    itemType: 'sell', images: [], title: '', desc: '', catSel: '', catNames: [],
    price: '', deposit: '', rentPeriod: 'day', rentLabel: '天',
    negotiable: true, genderPref: 'all', quality: '',
    qualities: QUALITIES, periods: PERIODS, cats: []
  },
  onLoad(opt) {
    if (opt.id) {
      this.setData({ isEdit: true, editId: parseInt(opt.id) });
      app.request('/api/marketplace/products/' + opt.id).then(p => {
        if (!p) return;
        this.setData({
          title: p.title || '', desc: p.desc || '', price: String(p.price || ''),
          deposit: String(p.deposit || ''), rentPeriod: p.rent_period || 'day',
          negotiable: p.negotiable !== false, genderPref: p.gender_pref || 'all',
          quality: p.quality || '', catSel: p.category || '', itemType: p.item_type || 'sell',
          images: p.images || [], wasRejected: p.status === 'rejected'
        });
        var rl = {day:'天',week:'周',month:'月'};
        this.setData({ rentLabel: rl[p.rent_period] || '天' });
      });
    }
    this.loadCats();
  },
  loadCats() {
    app.request('/api/marketplace/categories').then(d => {
      var arr = Array.isArray(d) ? d : [];
      var names = arr.map(function(c) { return typeof c === 'string' ? c : c.name || ''; }).filter(Boolean);
      this.setData({ cats: arr, catNames: names });
    });
  },
  setType(e) {
    var t = e.currentTarget.dataset.type;
    this.setData({ itemType: t });
    if (t === 'rent') this.setData({ genderPref: 'all' });
  },
  onTitle(e) { this.setData({ title: e.detail.value }); },
  onDesc(e) { this.setData({ desc: e.detail.value }); },
  onPrice(e) { this.setData({ price: e.detail.value }); },
  onDeposit(e) { this.setData({ deposit: e.detail.value }); },
  onCat(e) { this.setData({ catSel: this.data.catNames[e.detail.value] || '' }); },
  onPeriod(e) {
    var v = e.currentTarget.dataset.val;
    var rl = {day:'天',week:'周',month:'月'};
    this.setData({ rentPeriod: v, rentLabel: rl[v] || '天' });
  },
  onNegotiable(e) { this.setData({ negotiable: e.detail.value }); },
  pickGenderPref(e) { this.setData({ genderPref: e.currentTarget.dataset.val }); },
  pickQuality(e) { this.setData({ quality: e.currentTarget.dataset.val }); },
  pickImage() {
    wx.chooseImage({ count: 4 - this.data.images.length, sizeType: ['compressed'],
      success: res => {
        var imgs = this.data.images.slice();
        res.tempFilePaths.forEach(p => {
          try {
            var b64 = wx.getFileSystemManager().readFileSync(p, 'base64');
            imgs.push('data:image/jpeg;base64,' + b64);
          } catch(e) {}
        });
        this.setData({ images: imgs });
      }
    });
  },
  delImage(e) {
    var imgs = this.data.images.slice();
    imgs.splice(e.currentTarget.dataset.index, 1);
    this.setData({ images: imgs });
  },
  validate() {
    var d = this.data;
    if (!d.title.trim()) return app.toast('请输入物品名称');
    if (!d.catSel) return app.toast('请选择分类');
    if (d.itemType === 'sell' && !d.price) return app.toast('请输入售价');
    if (d.itemType === 'rent' && !d.price) return app.toast('请输入租金');
    if (!d.quality) return app.toast('请选择新旧程度');
    return true;
  },
  publish() {
    if (this.validate() !== true) return;
    wx.showLoading({ title: '发布中' });
    var d = this.data;
    var method = d.isEdit ? 'PATCH' : 'POST';
    var url = d.isEdit ? '/api/marketplace/products/' + d.editId + '/owner-edit' : '/api/marketplace/products';
    var u = app.globalData.user || wx.getStorageSync('user');
    var body = {
      title: d.title.trim(), desc: d.desc.trim(), category: d.catSel,
      price: parseFloat(d.price) || 0, item_type: d.itemType,
      quality: d.quality, negotiable: d.negotiable,
      gender_pref: d.genderPref, images: d.images
    };
    if (d.isEdit) {
      delete body.item_type;
    } else {
      body.owner_student_id = u.student_id;
      body.owner_name = u.name || '';
      body.school = u.school || '';
    }
    if (d.itemType === 'rent') {
      body.rent_price = parseFloat(d.price) || 0;
      body.deposit = parseFloat(d.deposit) || 0;
      body.rent_period = d.rentPeriod;
      body.price = 0;
    }
    app.request(url, method, body).then(r => {
      wx.hideLoading();
      if (r && r.ok) {
        app.toast(d.isEdit ? '保存成功' : '发布成功', 'success');
        setTimeout(() => wx.navigateBack(), 1000);
      } else {
        app.toast(r.error || r.msg || '操作失败');
      }
    }).catch(() => { wx.hideLoading(); app.toast('网络错误'); });
  },
  saveOnly() { this.publish(); },
  saveAndSubmit() {
    if (this.validate() !== true) return;
    wx.showLoading({ title: '提交中' });
    var d = this.data;
    app.request('/api/marketplace/products/' + d.editId + '/resubmit', 'POST', {}).then(r => {
      wx.hideLoading();
      if (r && r.ok) { app.toast('已重新提交审核', 'success'); setTimeout(() => wx.navigateBack(), 1000); }
      else app.toast(r.error || '提交失败');
    }).catch(() => { wx.hideLoading(); app.toast('网络错误'); });
  },
  goBack() { wx.navigateBack(); }
});
