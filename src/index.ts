import fs from 'fs/promises'
import { Context, Schema,Session } from 'koishi'
import type { OneBot } from 'koishi-plugin-adapter-onebot'
import path from 'path'


export const name = 'ysyunhei'
export const ADMIN_DIR = 'external/ysyunhei/admin'
//填入api key

export interface Config {
  api_key:string
}

export const Config: Schema<Config> = Schema.object({
    api_key:Schema.string()
})

//并发控制函数
async function processInBatches<T>(
  items: T[], 
  processor: (item: T) => Promise<any>, 
  batchSize: number = 10
): Promise<any[]> {
  const results: any[] = [];
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  
  return results;
}
//时间转换为秒，禁言用
function time2Seconds(timeStr: string) {
    if (!timeStr) return 0;
    
    const regex = /(\d+)\s*(天|小时|时|分钟|分)/g;
    let totalSeconds = 0;
    let match;

    while ((match = regex.exec(timeStr)) !== null) {
        const num = parseInt(match[1], 10);
        const unit = match[2];
        
        if (unit === '天') {
            totalSeconds += num * 86400;  // 1天 = 86400秒
        } else if (unit === '小时' || unit === '时') {
            totalSeconds += num * 3600;   // 1小时 = 3600秒
        } else if (unit === '分钟' || unit === '分') {
            totalSeconds += num * 60;     // 1分钟 = 60秒
        }
    }
    return totalSeconds;
}

//描述添加日期，在多个描述存在时方便整理发生时间
function dayRecord(desc:string): string {
  const now = new Date(); // 获取当前日期对象
  const year = now.getFullYear(); // 获取完整年份（4位数）
  const month = String(now.getMonth() + 1).padStart(2, '0'); // 月份补零（0 → "01"）
  const day = String(now.getDate()).padStart(2, '0'); // 日期补零（5 → "05"）
  return `${desc}（${year}-${month}-${day}）`; // 返回 YYYY-MM-DD
}

//获取管理员列表
async function loadAdmins(groupId: string) {
  // 确保admin目录存在
  await fs.mkdir(ADMIN_DIR, { recursive: true })
  const filePath = path.join(ADMIN_DIR, `${groupId}.json`)
  try {
    // 检查文件是否存在
    await fs.access(filePath)
    // 读取文件内容
    const data = await fs.readFile(filePath, 'utf-8')
    return data;
  } catch (error) {
    // 如果文件不存在或读取失败，创建一个空的配置文件
    await fs.writeFile(filePath, '{}', 'utf-8')
    return {};
  }
}
//删除管理员
async function delAdmin(admins: object, qqnum: string, groupnum: string) {
  let qqname:string=admins[qqnum]
  delete admins[qqnum]
  //保存管理员名单
  const filePath = path.join(ADMIN_DIR, `${groupnum}.json`)
  await fs.writeFile(filePath, JSON.stringify(admins, null, 2), 'utf-8')
  return `已将用户${qqname}（${qqnum}）移出群管理员。\n请注意：不同的群组有自己的管理员名单，需要在相应群组单独设置。`
}


//添加黑名单用户
export async function add(ctx: Context, meta: Session, qqnum: string, level: number, desc: string, bantime: string,config: Config) {
  //检查是否为群聊环境
  if (meta.guildId === undefined) {
    return '错误：请在群组内使用命令。'
  }
  //检查机器人权限
  let bot: OneBot.GroupMemberInfo = await meta.onebot.getGroupMemberInfo(meta.guildId, meta.selfId)
  if (bot.role == 'member') {
    return '错误：本功能需要机器人为群组管理员，请联系群主设置。'
  }
  //检查使用者是否为管理
  let user: OneBot.GroupMemberInfo = await meta.onebot.getGroupMemberInfo(meta.guildId, meta.userId)
  let admins=await loadAdmins(meta.guildId)
  admins = JSON.parse(admins as string)
  if (!(user.user_id in admins)) {
    return '错误：您没有使用该命令的权限。'
  }
  //检查等级参数
  if (![1, 2, 3].includes(level)) {
    return '错误：等级参数错误，应为1~3。'
  }
  //封禁时长设置，如果等级为1则设置为一年（31536000s），如果大于1则为永久（0s）
  let expiration: number = level == 1 ? 31536000 : 0
  //获取黑名单用户信息
  try {
    let blacklist_person=await ctx.http.get(`https://yunhei.youshou.wiki/get_platform_users?api_key=${config.api_key}&mode=1&search_type=1&account_type=1&account=${qqnum}`)
    if (blacklist_person.code==0){
      return '错误：API Key 无效或未启用，请检查配置。'
    }
    let post=await ctx.http.post(`https://yunhei.youshou.wiki/add_platform_users?api_key=${config.api_key}&account_type=1&name=${qqnum}&level=${level}&registration=${admins[user.user_id]}&expiration=${expiration}&desc=${dayRecord(desc)}`)
    if (post.code==0) {
      return `错误：添加失败，请检查参数是否正确。若所有参数无误仍添加失败，请联系开发者。\n失败原因：API Key 无效或未启用。`
    }
    if (post.code==1) {
      //显示记录违规时长并执行相关操作
      let measure:string=`记录违规信息`
      if (level==1) {  //1级（轻微）仅记录时长一年
        measure += `，时长一年`
      } else if (level==2) {  //2级（中等）记录时长永久并禁言
        measure = '永久' + measure
      } else if (level==3) {  //3级（严重）记录时长永久并踢群
        try {
          await meta.onebot.setGroupKick(meta.guildId, qqnum, false)
          measure = '踢出群并永久' + measure
        } catch (error) {
          return `踢出用户失败：${error}`
        }
      }
      //禁言处理
      if (!(bantime == undefined)){
        try {
          await meta.onebot.setGroupBan(meta.guildId, qqnum, time2Seconds(bantime))
          measure += `并禁言${bantime}`
        } catch (error) {
          return `禁言用户失败：${error}`
        }
      }
      //显示处理结果部分
      blacklist_person=await ctx.http.get(`https://yunhei.youshou.wiki/get_platform_users?api_key=${config.api_key}&mode=1&search_type=1&account_type=1&account=${qqnum}`)
      let data = blacklist_person.data
      let nickname:string = (await meta.onebot.getStrangerInfo(data.account_name)).nickname
      return `已将${nickname}（${qqnum}）${measure}。\n违规原因：${data.describe}\n严重程度：${data.level}\n措施：${measure}\n登记人：${data.registration}\n上黑时间：${data.add_time}`
    }
  } catch (error) {
    return `错误：添加用户失败。原因：${error}`
  }  
}


//查询黑名单用户
export async function check(ctx: Context, meta: Session, qqnum: string, config: Config) {
  //检查是否为群聊环境
  if (meta.guildId === undefined) {
    return '错误：请在群组内使用命令。'
  }
  //检查机器人权限
  let bot: OneBot.GroupMemberInfo = await meta.onebot.getGroupMemberInfo(meta.guildId, meta.selfId)
  if (bot.role == 'member') {
    return '错误：本功能需要机器人为群组管理员，请联系群主设置。'
  }
  //检查使用者是否为管理
  let user: OneBot.GroupMemberInfo = await meta.onebot.getGroupMemberInfo(meta.guildId, meta.userId)
  let admins=await loadAdmins(meta.guildId)
  admins = JSON.parse(admins as string)
  if (!(user.user_id in admins)) {
    return '错误：您没有使用该命令的权限。'
  }
  //查询所有用户信息
  if (qqnum===undefined) {
    meta.send(`正在检查群内所有人员……`)
    let group_members=await meta.onebot.getGroupMemberList(meta.guildId)
    let res,detectnum:number,light:number,moderate:number,severe:number,severe_users:string[]=[]
    detectnum=light=moderate=severe=0
    const membersToCheck = group_members.filter(member => member.role === 'member');
    const results = await processInBatches(membersToCheck, async (member) => {
    try {
      const res = await ctx.http.get(
        `https://yunhei.youshou.wiki/get_platform_users?api_key=${config.api_key}&mode=1&search_type=1&account_type=1&account=${member.user_id}`
      )
      if (res.code == 0) {
        throw new Error('API Key 无效或未启用，请检查配置。')
      }
      //等级判定
      if (!(res.data.length === 0)) {
        detectnum+=1
        if (res.data.level==`轻微`) {
          light+=1
        } else if (res.data.level==`中等`) {
          moderate+=1
        } else if (res.data.level==`严重`) {
          severe+=1
          //构建严重用户信息并尝试踢群
          severe_users.push(`${member.nickname}（${member.user_id}）\n违规原因：${res.describe}\n登记人：${res.registration}\n上黑时间：${res.add_time}`)
          try {
            await meta.onebot.setGroupKick(meta.guildId, member.user_id, false)
          } catch (error) {
            return `踢出用户失败：${error}`
          }
        }
        return { member, data: res.data };
      }
    } catch (error) {
      return { member, error: error.message };
    }}, 20)
    //生成报告
    let report:string
    if (detectnum == 0) {
      report = "未检查出任何位于黑名单内的成员。"
    } else {
        report = `检测到${detectnum}名违规用户。其中等级轻微者${light}人，等级中等者${moderate}人，等级严重者${severe}人。`
        if (!(severe_users.length === 0)){
          report += `\n严重用户列表：\n${severe_users.join('\n')}\n列表中的用户已被踢出群聊。`
        }
      }
      meta.send(`${report}\n检查完毕，感谢您的使用。`)
  } else {
    //查询单个用户信息
    try {
      let blacklist_person=await ctx.http.get(`https://yunhei.youshou.wiki/get_platform_users?api_key=${config.api_key}&mode=1&search_type=1&account_type=1&account=${qqnum}`)
      if (blacklist_person.code==0){
        return '错误：API Key 无效或未启用，请检查配置。'
      }
      if (blacklist_person.data.length === 0) {
        return `查询失败，该用户不在黑名单中。` 
      } else {
        let data=blacklist_person.data
        let nickname:string = (await meta.onebot.getStrangerInfo(data.account_name)).nickname
        let res:string=`账号类型：${data.platform}\n用户名：${nickname}\nQQ号：${data.account_name}\n违规原因：${data.describe}\n严重等级：${data.level}\n登记人：${data.registration}\n上黑时间：${data.add_time}\n过期时间：${data.expiration}\n查询云黑请见：https://yunhei.youshou.wiki`
        return res
      }
 } catch (error) {return `错误：查询用户失败。原因：${error}`}
}
}

//管理员管理
export async function admin(options: any, meta: Session) {
  //检查是否为群聊环境
  if (meta.guildId === undefined) {
    return '错误：请在群组内使用命令。'
  }
  //检查机器人权限
  let bot: OneBot.GroupMemberInfo = await meta.onebot.getGroupMemberInfo(meta.guildId, meta.selfId)
  if (bot.role == 'member') {
    return '错误：本功能需要机器人为群组管理员，请联系群主设置。'
  }
  //检查使用者是否为管理
  let user: OneBot.GroupMemberInfo = await meta.onebot.getGroupMemberInfo(meta.guildId, meta.userId)
  let admins=await loadAdmins(meta.guildId)
  admins = JSON.parse(admins as string)
  if (!(user.user_id in admins)) {
    return '错误：您没有使用该命令的权限。'
  }
  //排除可能出现的使用多个命令情况
  if ((options.add && options.del)||(options.del && options.list)||(options.add && options.list)){
    return '错误：请勿同时使用两个及以上的参数'
  } else if (options.add) {  //处理添加管理员操作
    if (options.add in admins) {
      return '错误：该用户在管理员名单中已存在。'
    } else {
      let qqname:string=options.name?options.name:await (await meta.onebot.getStrangerInfo(options.add)).nickname
      admins[options.add] = qqname
      //保存管理员名单
      const filePath = path.join(ADMIN_DIR, `${meta.guildId}.json`)
      await fs.writeFile(filePath, JSON.stringify(admins, null, 2), 'utf-8')
      return `已将用户${qqname}（${options.add}）设为群云黑管理员。\n请注意：不同的群组有自己的管理员名单，需要在相应群组单独设置。`
    }
  } else if (options.del) {  //处理删除管理员操作
    if (!(options.del in admins)) {
      return '错误：该用户在管理员名单中不存在。'
    } else {
      //额外操作：当操作对象为自己时，确认是否删除自己
      if (options.del == meta.userId) {
        await meta.send('您确定删除自己吗？输入y确认，输入其他字符将取消操作。')
        const selfdelconfirm = await meta.prompt()
        if ((selfdelconfirm=='y')||(selfdelconfirm=='Y')) {
          return delAdmin(admins, options.del, meta.guildId)
        } else return '操作已取消。'
      } else return delAdmin(admins, options.del, meta.guildId)
    }
  } else if (options.list) {
    return `本群的管理员如下：\n${Object.keys(admins).map(key => `${admins[key]}（${key}）`).join('\n')}\n\n请注意：不同的群组有自己的管理员名单，需要在相应群组单独设置。`
  }
}
export function apply(ctx: Context,config: Config) {
  ctx.command('yunhei.add <qqnum> <level:number> <desc> [bantime]')
    .action(({ session }, qqnum, level, desc, bantime) => add(ctx, session, qqnum, level, desc, bantime, config))
  ctx.command('yunhei.chk [qqnum]')
    .action(({ session }, qqnum) => check(ctx, session, qqnum, config))
  ctx.command('yunhei.admin').option('add', '<qqnum>').option('name','<name>').option('del','<qqnum>').option('list','--list')
    .action(({session,options}) => admin(options, session))
  // 加群时默认使所有管理获得bot权限
  ctx.on('guild-added',async (session) => {
    let group_members=await session.onebot.getGroupMemberList(session.guildId)
    let group_admins={}
    for (let member of group_members){
      if ((member.role=='admin')||(member.role=='owner')){
        group_admins[member.user_id]=member.nickname
      }
    }
    await fs.mkdir(ADMIN_DIR, { recursive: true })
    const filePath = path.join(ADMIN_DIR, `${session.guildId}.json`)
    await fs.writeFile(filePath, JSON.stringify(group_admins, null, 2), 'utf-8')
    session.send(`云黑机器人已加入该群，并默认使群主和所有管理获得机器人使用权限。\n本群的管理员如下：\n${Object.keys(group_admins).map(key => `${group_admins[key]}（${key}）`).join('\n')}\n机器人的禁言与踢群功能需要群管理员权限，请群主尽快为机器人授予相应权限。\n如需修改管理员名称，请咨询机器人持有者。`)
  })
}