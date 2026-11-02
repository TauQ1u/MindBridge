/*
 * Allen 小鼠脑 CCFv3 结构配置。
 *
 * 配色交互：默认全部脑区为中性灰壳（含 mPFC），
 * 点击选中后才显示该脑区的预设色。
 * 预设色按解剖功能家族分配：同族同色系深浅区分，
 * 跨族色相区分；mPFC 为全图唯一暖亮高亮色。
 */

export interface BrainStructureInfo {
  id: string
  /** 中文名 */
  name: string
  /** 英文名 / 缩写 */
  englishName: string
  /** 选中后显示的预设颜色 */
  color: string
  /** 是否高亮目标脑区 */
  highlight?: boolean
  /** 功能介绍（右侧面板展示） */
  description: string
}

export const BRAIN_SHELL_COLOR = '#e3e5e8'
export const BRAIN_LONG_AXIS = 12

/** 未选中状态的统一中性灰 */
export const STRUCTURE_GRAY = '#9aa0a6'
/** mPFC 预设色：原木色（首页与工作台统一 #DEB887） */
export const MPFC_COLOR = '#DEB887'
/** mPFC 透明壳不透明度（保持可隐约看到内部） */
export const MPFC_SHELL_OPACITY = 0.45

/*
 * 未选中结构的基础透明度层级（菲涅尔透明的上限）：
 * 大结构更透，核团亚区稍实，仅用透明度区分层级。
 */
const MAJOR_STRUCTURE_IDS = new Set([
  'cortex',
  'subcortical',
  'cerebellum',
  'brainstem',
])

export function getStructureOpacity(id: string) {
  return MAJOR_STRUCTURE_IDS.has(id) ? 0.65 : 0.8
}

export const ALLEN_BRAIN_MODEL_URL =
  `${import.meta.env.BASE_URL}models/allen-ccf-2017-root-997.obj`

// Allen CCFv3 结构网格：大结构 → 次级结构 → 核团亚区。
export const ALLEN_STRUCTURE_MODEL_URLS: Record<string, string> = {
  cortex: `${import.meta.env.BASE_URL}models/allen-ccf-2017-cerebral-cortex-688.obj`,
  subcortical: `${import.meta.env.BASE_URL}models/allen-ccf-2017-cerebral-nuclei-623.obj`,
  cerebellum: `${import.meta.env.BASE_URL}models/allen-ccf-2017-cerebellum-512.obj`,
  brainstem: `${import.meta.env.BASE_URL}models/allen-ccf-2017-brainstem-313.obj`,
  hpf: `${import.meta.env.BASE_URL}models/allen-ccf-2017-hpf-1089.obj`,
  claustrum: `${import.meta.env.BASE_URL}models/allen-ccf-2017-claustrum-254.obj`,
  endopiriform: `${import.meta.env.BASE_URL}models/allen-ccf-2017-endopiriform-233.obj`,
  la: `${import.meta.env.BASE_URL}models/allen-ccf-2017-la-131.obj`,
  bla: `${import.meta.env.BASE_URL}models/allen-ccf-2017-bla-295.obj`,
  bma: `${import.meta.env.BASE_URL}models/allen-ccf-2017-bma-247.obj`,
  pa: `${import.meta.env.BASE_URL}models/allen-ccf-2017-pa-771.obj`,
  mpfc: `${import.meta.env.BASE_URL}models/allen-ccf-2017-pl-972.obj`,
}

export const BRAIN_STRUCTURES: BrainStructureInfo[] = [
  {
    id: 'mpfc',
    name: '内侧前额叶皮层',
    englishName: 'Medial Prefrontal Cortex (mPFC)',
    color: MPFC_COLOR,
    highlight: true,
    description:
      '内侧前额叶皮层是高级认知与情绪调控的核心枢纽，主导决策制定、社会行为、工作记忆与情绪调节。本系统基于 Han 等人 24 小时 mPFC 多模态数据集中 Mouse #1 的真实记录，展示 117 个 mPFC 神经元在清醒活动（直立探索、笼内移动、跑轮运动、筑巢）与睡眠（NREM / REM / 微觉醒）过程中的钙活动与动态功能连接，并对比健康、抑郁、给药后恢复三个条件下神经网络状态的差异。神经元数据采自该脑区的一个二维成像视野（以前边缘皮层 PL 网格作为 mPFC 的图谱代理），进入工作台可查看 117 个神经元的真实空间分布。',
  },
  {
    id: 'cortex',
    name: '大脑皮层',
    englishName: 'Cerebral Cortex',
    color: '#7fb3d5',
    description:
      '大脑皮层覆盖于大脑半球表面，是感觉整合、运动控制与高级认知功能的物质基础。小鼠皮层按功能划分为感觉区、运动区与联合区，其中前额叶区域与边缘系统形成密集的往返连接，参与情绪评估与行为决策。',
  },
  {
    id: 'subcortical',
    name: '皮层下核团',
    englishName: 'Cerebral Nuclei',
    color: '#8a97d6',
    description:
      '皮层下核团包括基底神经节等结构，负责动作选择、习惯形成与强化学习。它们接收皮层输入并经由丘脑回传，构成皮层-基底节环路，对行为输出的门控与动机驱动至关重要。',
  },
  {
    id: 'cerebellum',
    name: '小脑',
    englishName: 'Cerebellum',
    color: '#6fc3b8',
    description:
      '小脑位于大脑后下方，传统上被认为主导运动协调与平衡；近年研究表明其同样参与认知加工与情绪调节。小脑通过齿状核与丘脑、前额叶皮层形成功能连接。',
  },
  {
    id: 'brainstem',
    name: '脑干',
    englishName: 'Brain Stem',
    color: '#a3b86b',
    description:
      '脑干连接大脑与脊髓，包含中脑、脑桥与延髓，掌管呼吸、心率等基本生命体征，同时也是单胺类神经递质（5-HT、NE、DA）的主要来源，广泛调制全脑兴奋性与觉醒水平。',
  },
  {
    id: 'hpf',
    name: '海马体',
    englishName: 'Hippocampal Formation',
    color: '#b39ddb',
    description:
      '海马体是学习与记忆的核心结构，负责空间导航、情景记忆的编码与巩固。海马位置细胞构建环境认知地图，并与 mPFC 形成功能环路，在空间决策与焦虑行为中协同工作。',
  },
  {
    id: 'claustrum',
    name: '屏状核',
    englishName: 'Claustrum',
    color: '#e08fb3',
    description:
      '屏状核是位于皮层深部的薄层状结构，与几乎所有皮层区域存在双向连接，被认为参与意识整合、显著性检测与跨脑区信息同步，是近年来脑科学研究的热点结构。',
  },
  {
    id: 'endopiriform',
    name: '内梨形核',
    englishName: 'Endopiriform Nucleus',
    color: '#e8a88f',
    description:
      '内梨形核位于梨状皮层深部，与嗅觉信息加工及边缘系统功能相关，参与气味-情绪关联记忆的形成，并通过与杏仁核的连接影响情绪行为输出。',
  },
  {
    id: 'la',
    name: '外侧杏仁核',
    englishName: 'Lateral Amygdalar Nucleus',
    color: '#ef8a94',
    description:
      '外侧杏仁核是感觉信息进入杏仁核的主要门户，接收丘脑与皮层的感觉输入，在恐惧条件反射中负责条件刺激与非条件刺激的关联学习。',
  },
  {
    id: 'bla',
    name: '基底外侧杏仁核',
    englishName: 'Basolateral Amygdalar Nucleus',
    color: '#e06070',
    description:
      '基底外侧杏仁核是情绪学习与价值评估的关键节点，与 mPFC 存在密集的双向投射。BLA-mPFC 环路的动态平衡被认为是焦虑行为表达与消退的神经基础。',
  },
  {
    id: 'bma',
    name: '基底内侧杏仁核',
    englishName: 'Basomedial Amygdalar Nucleus',
    color: '#c94859',
    description:
      '基底内侧杏仁核主要参与嗅觉相关的情绪加工与社会行为调控，接收嗅球与梨状皮层输入，向腹侧纹状体与下丘脑投射，影响趋避决策。',
  },
  {
    id: 'pa',
    name: '后杏仁核',
    englishName: 'Posterior Amygdalar Nucleus',
    color: '#b23a52',
    description:
      '后杏仁核位于杏仁核复合体尾侧，参与先天社会行为（如交配、攻击）的调控，接收嗅觉与犁鼻感觉输入，与下丘脑行为控制环路紧密相连。',
  },
]

export function getStructureInfo(id: string) {
  return BRAIN_STRUCTURES.find((item) => item.id === id)
}
