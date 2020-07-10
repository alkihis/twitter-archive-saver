import TwitterArchive, { TwitterHelpers, Conversation, GDPRConversation, ScreenNameChange, GPDRScreenNameHistory, ArchiveSyntheticInfo, PartialFavorite, UserLoadObject, GDPRMoment, DMFile, PartialTweet, AdImpression, AdEngagement, AdMobileConversion, AdOnlineConversion } from 'twitter-archive-reader';
import JSZip from 'jszip';


function convertConversationToGDPRConversation(conversation: Conversation) : GDPRConversation {
  return {
    dmConversation: {
      conversationId: conversation.id,
      messages: [...TwitterHelpers.getEventsFromMessages(conversation.all, true, true)]
    }
  };
}

function isGdprSNHArray(array: ScreenNameChange[] | GPDRScreenNameHistory[]) : array is GPDRScreenNameHistory[] {
  if (array.length) {
    return 'screenNameChange' in array[0];
  }
  return false;
}

export interface ArchiveSave {
  tweets: PartialTweet[] | ArrayBuffer | null;
  dms: GDPRConversation[] | ArrayBuffer | null;
  info: ArchiveSyntheticInfo;
  mutes: string[];
  blocks: string[];
  /** 1.0.0: `GPDRScreenNameHistory[]` ; 1.1.0+: `ScreenNameChange[]` */
  screen_name_history: ScreenNameChange[] | GPDRScreenNameHistory[];
  /** 1.1.0+ */
  favorites?: PartialFavorite[];
  /** 1.1.0+ */
  user?: UserLoadObject;

  followers?: string[];
  followings?: string[];
  moments?: GDPRMoment[];
  lists?: {
    created: string[];
    member_of: string[];
    subscribed: string[];
  };
  ad_archive?: AdSave | ArrayBuffer | null;
}

interface AdSave {  
  impressions: AdImpression[],
  engagements: AdEngagement[],
  mobile_conversions: AdMobileConversion[],
  online_conversions: AdOnlineConversion[],
}

export interface ArchiveSaveOptions {
  tweets?: boolean;
  dms?: boolean;
  mutes?: boolean;
  favorites?: boolean;
  blocks?: boolean;
  followers?: boolean;
  followings?: boolean;
  moments?: boolean;
  lists?: boolean;
  ad_archive?: boolean;

  /** Summary user data and screen name history is always stored. */
  user?: {
    phone_number?: boolean, 
    verified?: boolean, 
    personalization?: boolean, 
    protected_history?: boolean, 
    age_info?: boolean, 
    email_address_changes?: boolean, 
    login_ips?: boolean, 
    timezone?: boolean, 
    applications?: boolean
  };
}

export class ArchiveSaver {
  static readonly SUPPORTED_SAVE_VERSIONS = ["1.0.0", "1.1.0", "2.0.0"];
  static readonly CURRENT_EXPORT_VERSION = "2.0.0";
  
  /**
   * Create a save from a Twitter Archive.
   * 
   * Restore an `ArchiveSave` with `.restore()`.
   * 
   * Default parameter for {options} is:
   * ```ts
   * options = {
   *  tweets: true, 
   *  dms: true, 
   *  mutes: true, 
   *  favorites: true, 
   *  blocks: true,
   *  user: {}
   * }
   * ```
   */
  static async create(archive: TwitterArchive, options: ArchiveSaveOptions = {
    tweets: true, 
    dms: true, 
    mutes: true, 
    favorites: true, 
    blocks: true,
    user: {},
  }) : Promise<ArchiveSave> {
    const info = archive.synthetic_info;

    let tweet_zip: PartialTweet[] | null = null;
    if (options.tweets) {
      tweet_zip = archive.tweets.all;
    }

    const mutes = options.mutes ? [...archive.mutes] : [];
    const blocks = options.blocks ? [...archive.blocks] : [];

    let dms: GDPRConversation[] | null = null;
    if (options.dms && archive.is_gdpr && archive.messages) {
      // Swallow copy all the dms, save them to a JSZip instance
      /* 
        dm.json => [
          GDPRConversation,
          ...
        ]
      */

      dms = archive.messages.all.map(convertConversationToGDPRConversation);
    }

    info.version = this.CURRENT_EXPORT_VERSION;

    let ads: AdSave | null = null;
    if (options.ad_archive) {
      ads = {  
        impressions: archive.ads.impressions,
        engagements: archive.ads.engagements,
        mobile_conversions: archive.ads.mobile_conversions,
        online_conversions: archive.ads.online_conversions,
      };
    }

    const save: ArchiveSave = {
      tweets: tweet_zip,
      dms,
      info,
      mutes,
      blocks,
      followers: options.followers ? [...archive.followers] : undefined,
      followings: options.followings ? [...archive.followings] : undefined,
      moments: options.moments ? archive.moments : undefined,
      lists: options.lists ? archive.lists : undefined,
      ad_archive: ads,
      screen_name_history: archive.user.screen_name_history,
      favorites: options.favorites ? archive.favorites.all : [],
      user: {},
    };

    // Userdata ok
    if (options.user && Object.keys(options.user).length) {
      for (const [name, value] of Object.entries(archive.user.dump())) {
        if (value && name in options.user) {
          // @ts-ignore
          save.user[name] = value;
        }
      }
    }

    return save;
  }

  /**
   * Create a Twitter Archive from an `ArchiveSave`.
   */
  static async restore(save: ArchiveSave | Promise<ArchiveSave>) {
    save = await save;

    if (!this.SUPPORTED_SAVE_VERSIONS.includes(save.info.version)) {
      throw new Error("Save version is not supported.");
    }

    const archive = new TwitterArchive(null);
    const save_info = save.info;
    if (save.info.version === "1.0.0" && 'index' in save_info) {
      // @ts-ignore
      archive.loadClassicArchivePart({ user: save_info.index.info });
    }
    else {
      archive.loadClassicArchivePart({ user: save_info.info.user });
    }

    if (save.tweets instanceof ArrayBuffer) {
      const tweet_archive = await JSZip.loadAsync(save.tweets);
      let current_load_object = JSON.parse(await tweet_archive.file("tweet.json")!.async("text"));
  
      // Tweets are extracted from a previous archive, they've been converted to classic format.
      archive.loadClassicArchivePart({ tweets: current_load_object });
    }
    else if (save.tweets instanceof Array) {
      // PartialTweet[]
      archive.loadClassicArchivePart({ tweets: save.tweets });
    }

    if (save.info.is_gdpr) {
      // Side effect of this method is to define archive to GDPR format
      await archive.loadArchivePart();
    }

    if (save.dms instanceof ArrayBuffer) {
      const dm_archive = await JSZip.loadAsync(save.dms);
      let current_load_object = JSON.parse(await dm_archive.file("dm.json")!.async("text")) as DMFile;

      await archive.loadArchivePart({
        dms: [current_load_object]
      });
    }
    else if (save.dms instanceof Array) {
      await archive.loadArchivePart({ dms: [save.dms] });
    }

    if (save.mutes && save.mutes.length) {
      await archive.loadArchivePart({
        mutes: save.mutes,
      });
    }
    if (save.blocks && save.blocks.length) {
      await archive.loadArchivePart({
        blocks: save.blocks,
      });
    }
    if (save.followers && save.followers.length) {
      await archive.loadArchivePart({
        followers: save.followers,
      });
    }
    if (save.followings && save.followings.length) {
      await archive.loadArchivePart({
        followings: save.followings,
      });
    }
    if (save.moments && save.moments.length) {
      await archive.loadArchivePart({
        moments: save.moments,
      });
    }
    if (save.lists) {
      archive.lists.created = save.lists.created;
      archive.lists.member_of = save.lists.member_of;
      archive.lists.subscribed = save.lists.subscribed;
    }
    if (save.ad_archive) {
      let current_load_object: AdSave;
      
      if (save.ad_archive instanceof ArrayBuffer) {
        const ad_archive = await JSZip.loadAsync(save.ad_archive);
        current_load_object = JSON.parse(await ad_archive.file("ads.json")!.async("text")) as any;
      }
      else {
        current_load_object = save.ad_archive;
      }

      archive.ads.impressions = current_load_object.impressions;
      archive.ads.engagements = current_load_object.engagements;
      archive.ads.online_conversions = current_load_object.online_conversions;
      archive.ads.mobile_conversions = current_load_object.mobile_conversions;
    }
    if (save.user) {
      archive.user.loadPart(save.user);
    }
    if (archive.is_gdpr) {
      if (save.favorites) {
        archive.favorites.add(save.favorites);
      }

      // Sideload screen name history
      const sn_h = save.screen_name_history;
      if (isGdprSNHArray(sn_h)) {
        archive.user.loadPart({
          screen_name_history: sn_h.map(e => e.screenNameChange)
        });
      }
      else {
        archive.user.loadPart({
          screen_name_history: sn_h
        });
      }
    }

    return archive;
  }
}

export default ArchiveSaver;
