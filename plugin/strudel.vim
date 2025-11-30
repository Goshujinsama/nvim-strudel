" nvim-strudel - Live coding music in Neovim
" Maintainer: Your Name
" License: AGPL-3.0

if exists('g:loaded_strudel')
  finish
endif
let g:loaded_strudel = 1

" Lazy-load the plugin - actual setup happens when user calls require('strudel').setup()
