#!/usr/bin/env lua
--- Run with:
--- nvim --clean --headless --cmd 'set runtimepath^=.' --cmd 'filetype plugin on' \
---   -c 'luafile tests/lua/filetype_spec.lua' -c 'qa!'

vim.cmd('edit /tmp/nvim-strudel-comment-test.strudel')
assert(vim.bo.filetype == 'strudel', 'expected .strudel filetype detection')
assert(vim.bo.commentstring == '// %s', 'expected JavaScript line comments')
assert(vim.bo.comments:match('://'), 'expected // in comments option')

vim.api.nvim_buf_set_lines(0, 0, -1, false, { 's("bd sd")' })
vim.api.nvim_win_set_cursor(0, { 1, 0 })
vim.api.nvim_feedkeys('gcc', 'xt', false)
vim.wait(100)
assert(vim.api.nvim_get_current_line() == '// s("bd sd")', 'gcc should comment Strudel code')

vim.api.nvim_feedkeys('gcc', 'xt', false)
vim.wait(100)
assert(vim.api.nvim_get_current_line() == 's("bd sd")', 'gcc should uncomment Strudel code')

print('✓ Strudel filetype commenting')
