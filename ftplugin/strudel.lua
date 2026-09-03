-- Strudel source uses JavaScript comment syntax.
vim.bo.commentstring = '// %s'
vim.bo.comments = 'sO:* -,mO:*  ,exO:*/,s1:/*,mb:*,ex:*/,://'

local undo = 'setlocal commentstring< comments<'
if vim.b.undo_ftplugin and vim.b.undo_ftplugin ~= '' then
  vim.b.undo_ftplugin = vim.b.undo_ftplugin .. ' | ' .. undo
else
  vim.b.undo_ftplugin = undo
end
