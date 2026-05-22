import type { AmazonCategoryNode } from '../types/mcp';

function sortName(node: AmazonCategoryNode): string {
  return (node.name || node.name_cn || node.path || node.node_id).trim().toLocaleLowerCase();
}

export function compareCategoryNodes(left: AmazonCategoryNode, right: AmazonCategoryNode): number {
  const levelOrder = left.level - right.level;
  if (levelOrder !== 0) return levelOrder;

  const nameOrder = sortName(left).localeCompare(sortName(right), 'en', {
    numeric: true,
    sensitivity: 'base',
  });
  if (nameOrder !== 0) return nameOrder;

  return left.node_id.localeCompare(right.node_id, 'en', {
    numeric: true,
    sensitivity: 'base',
  });
}

export function sortCategoryNodes(nodes: AmazonCategoryNode[]): AmazonCategoryNode[] {
  return [...nodes]
    .map((node) => ({ ...node, children: sortCategoryNodes(node.children ?? []) }))
    .sort(compareCategoryNodes);
}
