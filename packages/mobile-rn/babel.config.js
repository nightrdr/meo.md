module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // @meo/shared/dist/index.js uses `export * as ai from '...'`. The
    // RN preset's parser supports it but the transform needs an
    // explicit plugin until the preset bumps its target.
    '@babel/plugin-transform-export-namespace-from',
  ],
};
