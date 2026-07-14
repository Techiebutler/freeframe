import { describe, expect, it } from 'vitest'
import { insertCommentIntoTree, type CommentWithReplies } from '../use-comments'

// Minimal comment factory — only the fields insertCommentIntoTree touches.
function c(id: string, replies: CommentWithReplies[] = []): CommentWithReplies {
  return { id, replies } as CommentWithReplies
}

describe('insertCommentIntoTree', () => {
  it('appends a top-level comment to the root', () => {
    const tree = [c('a'), c('b')]
    const out = insertCommentIntoTree(tree, c('new'))
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'new'])
  })

  it('nests a reply under its parent', () => {
    const tree = [c('a'), c('p', [c('r1')])]
    const out = insertCommentIntoTree(tree, c('r2'), 'p')
    expect(out[1].replies.map((x) => x.id)).toEqual(['r1', 'r2'])
    expect(out[0].replies).toEqual([]) // untouched sibling
  })

  it('nests a reply under a deeply-nested parent', () => {
    const tree = [c('a', [c('b', [c('c')])])]
    const out = insertCommentIntoTree(tree, c('d'), 'c')
    expect(out[0].replies[0].replies[0].replies.map((x) => x.id)).toEqual(['d'])
  })

  it('does not mutate the input tree', () => {
    const tree = [c('p', [])]
    const snapshot = JSON.stringify(tree)
    insertCommentIntoTree(tree, c('r'), 'p')
    expect(JSON.stringify(tree)).toBe(snapshot)
  })

  it('returns the tree unchanged when the parent is not found', () => {
    const tree = [c('a'), c('b')]
    const out = insertCommentIntoTree(tree, c('r'), 'missing')
    expect(out.map((x) => x.id)).toEqual(['a', 'b'])
  })
})
