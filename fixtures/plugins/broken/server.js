module.exports = {
  async boom() {
    throw Object.assign(new Error('故意失败'), { code: 'BOOM' });
  },
};
