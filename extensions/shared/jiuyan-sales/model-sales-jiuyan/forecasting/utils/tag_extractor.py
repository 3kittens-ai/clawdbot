import re
import os

def load_keywords(tags_file_path):
    """从 docs/tags.md 加载所有业务关键词。"""
    keywords = set()
    if not os.path.exists(tags_file_path):
        return keywords
    
    with open(tags_file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 使用正则表达式提取所有列表项（关键字）
    lines = content.split('\n')
    for line in lines:
        line = line.strip()
        if line.startswith('- '):
            raw_text = line[2:]
            # 移除分类标题前缀，如 "经典钩型：" 或 "经典钩型:"
            if '：' in raw_text:
                raw_text = raw_text.split('：', 1)[1]
            elif ':' in raw_text:
                raw_text = raw_text.split(':', 1)[1]
                
            # 按逗号、中英文逗号、空格、顿号、。切分
            parts = re.split(r'[,，、\s。]+', raw_text)
            for part in parts:
                p = part.strip()
                if p and len(p) > 1: # 忽略单字
                    keywords.add(p)
    
    # 补充核心品类名作为标签
    keywords.update(['线组', '鱼钩', '子线', '浮漂'])
    return keywords

def extract_tags_from_name(sku_name, keyword_list):
    """
    在 SKU 名称中扫描匹配的关键词。
    优先匹配较长的词以避免误判（如“加长子线”优于“子线”）。
    返回按在原名中出现位置排序的标签列表。
    """
    if not sku_name:
        return []
    
    # 按长度降序排列关键词，确保优先匹配长词
    sorted_candidates = sorted(list(keyword_list), key=len, reverse=True)
    
    found_matches = [] # 存储 (start_index, tag)
    temp_name = sku_name.lower()
    
    for kw in sorted_candidates:
        kw_lower = kw.lower()
        # 查找所有出现的位置
        start = 0
        while True:
            idx = temp_name.find(kw_lower, start)
            if idx == -1:
                break
            # 检查这个位置是否已经被占据
            overlap = False
            for existing_idx, existing_tag in found_matches:
                if not (idx + len(kw) <= existing_idx or existing_idx + len(existing_tag) <= idx):
                    overlap = True
                    break
            
            if not overlap:
                found_matches.append((idx, kw))
            
            start = idx + 1
            
    # 按在名称中出现的顺序排列
    found_matches.sort()
    return [m[1] for m in found_matches]
